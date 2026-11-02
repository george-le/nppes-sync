"""Generic FHIR Provider Directory (PDEX Plan-Net) adapter.

Pulls PractitionerRole resources from a payer's public FHIR R4 endpoint in
one search per page, using _include to fetch the referenced Practitioner,
Location and Organization resources in the same bundle. Follows Bundle
"next" links. Each role is normalized to the common provider-record shape,
with name, NPI, address, phone and organization resolved where the server
returned them.

Standard library only, so it runs anywhere Python 3 does.

CLI:
    python3 sources/fhir_pd.py <payer_id> [--max-pages N] [--page-size N] [--out FILE]
    python3 sources/fhir_pd.py --all [--max-pages N]

Payer endpoints come from data/payer_endpoints.json.
"""

from __future__ import annotations

import argparse
import http.client
import json
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path
from typing import Any, Iterator

REPO_ROOT = Path(__file__).resolve().parent.parent
PAYERS_FILE = REPO_ROOT / "data" / "payer_endpoints.json"
NPI_SYSTEM_HINTS = ("us-npi", "/sid/us-npi", "npi")
USER_AGENT = "nppes-sync/0.1 (+provider-directory-adapter)"
INCLUDES = (
    "PractitionerRole:practitioner",
    "PractitionerRole:location",
    "PractitionerRole:organization",
)

Includes = dict[str, dict[str, Any]]  # "Type/id" -> resource


class FhirError(RuntimeError):
    def __init__(self, message: str, status: int | None = None):
        super().__init__(message)
        self.status = status


RETRIES = 2          # extra attempts for gateway errors and timeouts
RETRY_DELAY = 3.0    # seconds between attempts


def _get_json_once(url: str, timeout: float) -> dict[str, Any]:
    req = urllib.request.Request(
        url,
        headers={"Accept": "application/fhir+json", "User-Agent": USER_AGENT},
    )
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            body = resp.read()
    except urllib.error.HTTPError as e:
        raise FhirError(f"HTTP {e.code} for {url}", status=e.code) from e
    except urllib.error.URLError as e:
        raise FhirError(f"network error for {url}: {e.reason}") from e
    except (OSError, http.client.HTTPException) as e:  # timeouts, resets, bad status lines
        raise FhirError(f"read failed for {url}: {e!r}") from e
    try:
        return json.loads(body)
    except json.JSONDecodeError as e:
        raise FhirError(f"non-JSON response from {url}: {body[:120]!r}") from e


def _get_json(url: str, timeout: float = 60.0) -> dict[str, Any]:
    """GET with retries on 5xx responses and transport errors. 4xx fails at once."""
    for attempt in range(RETRIES + 1):
        try:
            return _get_json_once(url, timeout)
        except FhirError as e:
            retryable = e.status is None or e.status >= 500
            if not retryable or attempt == RETRIES:
                raise
            time.sleep(RETRY_DELAY)
    raise AssertionError("unreachable")


def metadata(base_url: str) -> dict[str, Any]:
    """GET {base}/metadata (CapabilityStatement). Not a reliable liveness check; see notes."""
    return _get_json(base_url.rstrip("/") + "/metadata")


def iter_roles(
    base_url: str,
    page_size: int = 100,
    max_pages: int | None = None,
    include: bool = True,
) -> Iterator[tuple[dict[str, Any], Includes]]:
    """Yield (PractitionerRole, includes) pairs, following Bundle 'next' links.

    `includes` maps "Type/id" to the included Practitioner, Location or
    Organization resource from the same page. Pass include=False for servers
    that reject _include; the names and addresses are then left unresolved.
    """
    params = [("_count", str(page_size))]
    if include:
        params += [("_include", inc) for inc in INCLUDES]
    url = f"{base_url.rstrip('/')}/PractitionerRole?{urllib.parse.urlencode(params)}"
    pages = 0
    while url:
        bundle = _get_json(url)
        if bundle.get("resourceType") != "Bundle":
            raise FhirError(f"expected Bundle from {url}, got {bundle.get('resourceType')}")

        includes: Includes = {}
        roles: list[dict[str, Any]] = []
        for entry in bundle.get("entry", []) or []:
            res = entry.get("resource") or {}
            rtype = res.get("resourceType")
            if not rtype:
                continue
            if (entry.get("search") or {}).get("mode") == "include" or rtype != "PractitionerRole":
                includes[f"{rtype}/{res.get('id')}"] = res
            else:
                roles.append(res)

        for role in roles:
            yield role, includes

        pages += 1
        if max_pages is not None and pages >= max_pages:
            return
        url = None
        for link in bundle.get("link", []) or []:
            if link.get("relation") == "next":
                url = urllib.parse.urljoin(base_url, link.get("url", ""))
                break


def _is_npi_identifier(ident: dict[str, Any]) -> bool:
    """NPI either by identifier system, or by a type coding of 'NPI' (Molina style)."""
    system = (ident.get("system") or "").lower()
    if any(h in system for h in NPI_SYSTEM_HINTS):
        return True
    codings = (ident.get("type") or {}).get("coding") or []
    return any((c.get("code") or "").upper() == "NPI" for c in codings)


def _npi_from_identifiers(identifiers: list[dict[str, Any]] | dict[str, Any] | None) -> str | None:
    if isinstance(identifiers, dict):  # FHIR allows a single Identifier where a list is expected
        identifiers = [identifiers]
    for ident in identifiers or []:
        value = ident.get("value")
        if value and _is_npi_identifier(ident) and str(value).isdigit():
            return str(value)
    return None


def _specialty(role: dict[str, Any]) -> tuple[str | None, str | None]:
    for spec in role.get("specialty", []) or []:
        for coding in spec.get("coding", []) or []:
            if coding.get("code") or coding.get("display"):
                return coding.get("code"), coding.get("display") or spec.get("text")
        if spec.get("text"):
            return None, spec["text"]
    return None, None


def _ref(obj: dict[str, Any] | None) -> str | None:
    if not obj:
        return None
    return obj.get("reference") or obj.get("display")


def _resolve(obj: dict[str, Any] | None, includes: Includes) -> dict[str, Any] | None:
    """Return the included resource a Reference points at, if the server sent it."""
    if not obj or not obj.get("reference"):
        return None
    ref = obj["reference"]
    # Absolute references: keep the last two path segments, "Type/id".
    key = "/".join(ref.rstrip("/").split("/")[-2:])
    return includes.get(key)


def _person_name(practitioner: dict[str, Any] | None) -> tuple[str | None, str | None, str | None]:
    """Return (display_name, first, last) from a Practitioner's first name entry."""
    if not practitioner:
        return None, None, None
    names = practitioner.get("name") or []
    # Prefer an "official" name, else the first one.
    name = next((n for n in names if n.get("use") == "official"), names[0] if names else None)
    if not name:
        return None, None, None
    given = " ".join(name.get("given") or []) or None
    family = name.get("family")
    prefix = " ".join(name.get("prefix") or [])
    suffix = " ".join(name.get("suffix") or [])
    display = " ".join(p for p in [prefix, given, family, suffix] if p) or name.get("text")
    return display, given, family


def _address(location: dict[str, Any] | None) -> dict[str, str | None]:
    addr = (location or {}).get("address") or {}
    lines = [l for l in addr.get("line") or [] if l]
    return {
        "line1": lines[0] if lines else None,
        "line2": " ".join(lines[1:]) or None,
        "city": addr.get("city"),
        "state": addr.get("state"),
        "postal_code": addr.get("postalCode"),
    }


def _phone(*resources: dict[str, Any] | None) -> str | None:
    """First telephone number found across the given resources' telecom lists."""
    for res in resources:
        for t in (res or {}).get("telecom") or []:
            if t.get("system") == "phone" and t.get("value"):
                return t["value"]
    return None


def normalize_role(role: dict[str, Any], includes: Includes, source_id: str) -> dict[str, Any]:
    """Map a PractitionerRole plus its included resources to the common provider-record shape.

    Works with or without _include. Without it, some servers still carry the
    practitioner and location display names inline on the role (Molina does).
    """
    practitioner = _resolve(role.get("practitioner"), includes)
    organization = _resolve(role.get("organization"), includes)
    locations = [_resolve(loc, includes) for loc in role.get("location") or []]
    primary_location = next((l for l in locations if l), None)

    display, first, last = _person_name(practitioner)
    if not display:
        display = (role.get("practitioner") or {}).get("display")
    spec_code, spec_display = _specialty(role)
    npi = (
        _npi_from_identifiers(role.get("identifier"))
        or _npi_from_identifiers((practitioner or {}).get("identifier"))
        or _npi_from_identifiers((role.get("practitioner") or {}).get("identifier"))
    )
    inline_location = next(
        (loc.get("display") for loc in role.get("location") or [] if loc.get("display")), None
    )

    return {
        "source": source_id,
        "source_provider_id": role.get("id"),
        "npi": npi,
        "name": display,
        "first_name": first,
        "last_name": last,
        "organization_name": (organization or {}).get("name") or _ref(role.get("organization")),
        "location_name": (primary_location or {}).get("name") or inline_location,
        "address": _address(primary_location),
        "phone": _phone(role, primary_location, organization),
        "specialty_code": spec_code,
        "specialty": spec_display,
        "practitioner_ref": _ref(role.get("practitioner")),
        "location_refs": [loc.get("reference") for loc in role.get("location") or [] if loc.get("reference")],
        "active": role.get("active"),
        "last_updated": (role.get("meta") or {}).get("lastUpdated"),
    }


def fetch_locations(base_url: str, pairs: list[tuple[dict[str, Any], Includes]]) -> tuple[Includes, int]:
    """Fetch each Location referenced by these roles once, by id.

    Used when the server rejects _include. Returns (includes, failures). A
    single failed Location lookup is counted and skipped, not fatal.
    """
    wanted: set[str] = set()
    for role, _ in pairs:
        for loc in role.get("location") or []:
            ref = loc.get("reference") or ""
            if ref.startswith("Location/"):
                wanted.add(ref)
    found: Includes = {}
    failures = 0
    for ref in sorted(wanted):
        try:
            found[ref] = _get_json(f"{base_url.rstrip('/')}/{ref}")
        except FhirError:
            failures += 1
    return found, failures


def load_payers() -> list[dict[str, Any]]:
    with PAYERS_FILE.open() as f:
        return json.load(f)["payers"]


SCOPE_STATE = "CA"


def in_scope(record: dict[str, Any], state: str = SCOPE_STATE) -> bool:
    """True when the record's practice address is in the target state."""
    addr_state = (record.get("address") or {}).get("state")
    return bool(addr_state) and addr_state.strip().upper() == state.upper()


def sync_payer(
    payer: dict[str, Any],
    page_size: int,
    max_pages: int | None,
    state: str | None = SCOPE_STATE,
) -> dict[str, Any]:
    """Pull and normalize one payer. Returns a summary; never raises for a bad endpoint."""
    base = payer.get("baseUrl")
    summary: dict[str, Any] = {"payer": payer["id"], "name": payer.get("name"), "ok": False}
    if not base:
        summary["error"] = "no baseUrl (" + (payer.get("auth") or "unknown auth") + ")"
        return summary
    include = True
    location_failures = 0
    try:
        try:
            pairs = list(iter_roles(base, page_size, max_pages, include=True))
        except FhirError as e:
            if e.status != 400:
                raise
            # Server rejects _include: plain search, then fetch each Location by id.
            include = False
            pairs = list(iter_roles(base, page_size, max_pages, include=False))
            locations, location_failures = fetch_locations(base, pairs)
            pairs = [(role, {**locations}) for role, _ in pairs]
    except FhirError as e:
        summary["error"] = str(e)
        return summary
    all_records = [normalize_role(role, inc, payer["id"]) for role, inc in pairs]
    if state:
        records = [r for r in all_records if in_scope(r, state)]
    else:
        records = all_records
    summary.update(
        ok=True,
        includes_used=include,
        location_failures=location_failures,
        scanned=len(all_records),
        out_of_scope=len(all_records) - len(records),
        scope_state=state,
        roles=len(records),
        with_npi=sum(1 for r in records if r["npi"]),
        with_name=sum(1 for r in records if r["name"]),
        with_address=sum(1 for r in records if r["address"]["line1"] or r["address"]["city"]),
        with_phone=sum(1 for r in records if r["phone"]),
        with_specialty=sum(1 for r in records if r["specialty"]),
        records=records,
    )
    return summary


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("payer", nargs="?", help="payer id from data/payer_endpoints.json")
    ap.add_argument("--all", action="store_true", help="run every payer that has a baseUrl")
    ap.add_argument("--max-pages", type=int, default=2, help="pages per payer (default 2; 0 = all)")
    ap.add_argument("--page-size", type=int, default=100)
    ap.add_argument("--out", type=Path, help="write normalized records as JSON lines")
    ap.add_argument(
        "--state",
        default=SCOPE_STATE,
        help=f"keep only roles whose practice address is in this state (default {SCOPE_STATE}; 'all' disables)",
    )
    args = ap.parse_args(argv)
    state = None if args.state.lower() == "all" else args.state.upper()

    if not args.payer and not args.all:
        ap.error("give a payer id or --all")
    max_pages = None if args.max_pages == 0 else args.max_pages

    payers = load_payers()
    if args.payer:
        payers = [p for p in payers if p["id"] == args.payer]
        if not payers:
            print(f"unknown payer id: {args.payer}", file=sys.stderr)
            return 2

    out_f = args.out.open("w") if args.out else None
    failed = 0
    try:
        for payer in payers:
            result = sync_payer(payer, args.page_size, max_pages, state)
            if not result["ok"]:
                failed += 1
                print(f"[FAIL] {payer['id']:<20} {result['error']}")
                continue
            note = (
                ""
                if result["includes_used"]
                else f" (plain search; locations fetched individually, {result['location_failures']} failed)"
            )
            print(
                f"[ OK ] {payer['id']:<20} scanned={result['scanned']} kept={result['roles']} "
                f"out_of_scope={result['out_of_scope']} name={result['with_name']} "
                f"npi={result['with_npi']} address={result['with_address']} "
                f"phone={result['with_phone']} specialty={result['with_specialty']}{note}"
            )
            if out_f:
                for rec in result["records"]:
                    out_f.write(json.dumps(rec) + "\n")
    finally:
        if out_f:
            out_f.close()
    return 1 if failed and not args.all else 0


if __name__ == "__main__":
    raise SystemExit(main())
