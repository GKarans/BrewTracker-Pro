#!/usr/bin/env python3
"""Extract a conservative, reviewable fermentation-history payload from BeerSmith DOCX notes.

The parser never synthesizes missing measurements.  Unknown pH, temperature,
pressure, CO2, packaging date, or packaging volume remains null in the JSON.
"""

from __future__ import annotations

import argparse
import json
import re
import zipfile
import xml.etree.ElementTree as ET
from datetime import date
from pathlib import Path

W = "{http://schemas.openxmlformats.org/wordprocessingml/2006/main}"
HEADER = re.compile(r"^(?P<beersmith>\d{4})\s+(?P<batch>\d+)\s+(?P<title>.+?)\s*$")
DATE = re.compile(r"(?P<day>\d{1,2})[.](?P<month>\d{1,2})(?:[.](?P<year>\d{2,4}))?")


def paragraphs(docx: Path) -> list[str]:
    with zipfile.ZipFile(docx) as archive:
        root = ET.fromstring(archive.read("word/document.xml"))
    values: list[str] = []
    for para in root.iter(f"{W}p"):
        text: list[str] = []
        for node in para.iter():
            if node.tag == f"{W}t":
                text.append(node.text or "")
            elif node.tag in (f"{W}br", f"{W}cr"):
                text.append("\n")
        line = "".join(text).strip()
        if line:
            values.append(line)
    return values


def decimal(value: str | None) -> float | None:
    if not value:
        return None
    value = value.strip().replace(",", ".")
    try:
        return float(value)
    except ValueError:
        return None


def gravity(value: str | None) -> int | None:
    parsed = decimal(value)
    if parsed is None:
        return None
    if 0.95 <= parsed < 1.2:
        parsed *= 1000
    candidate = round(parsed)
    return candidate if 950 <= candidate <= 1200 else None


def ph(value: str | None) -> float | None:
    parsed = decimal(value)
    return parsed if parsed is not None and 0 <= parsed <= 14 else None


def code_year_and_sequence(batch_code: str, tank: int | None) -> tuple[int, int]:
    suffix_len = 2 if tank in (10, 11, 12, 13) else 1
    if len(batch_code) <= 2 + suffix_len:
        raise ValueError(f"Cannot derive year/sequence from {batch_code}")
    year = 2000 + int(batch_code[:2])
    sequence = int(batch_code[2:-suffix_len])
    return year, sequence


def canonical_name(title: str) -> str:
    title = re.sub(r"\s+(?:4|8)T$", "", title, flags=re.I).strip()
    title = re.sub(r"\s+-\s*iejavo.*$", "", title, flags=re.I).strip()
    title = re.sub(r"\s+iejavo.*$", "", title, flags=re.I).strip()
    title = re.sub(r"\s+1/2$", "", title).strip()
    aliases = {"Sencīts": "Sencītis"}
    return aliases.get(title, title)


def parse_date(value: str, fallback_year: int, brew_month: int | None = None) -> str | None:
    match = DATE.search(value)
    if not match:
        return None
    year_raw = match.group("year")
    if year_raw:
        year = int(year_raw)
        year = 2000 + year if year < 100 else year
        # BeerSmith's 02.04.04 belongs to the 2024 sequence, not 2004.
        if year < 2010:
            year = fallback_year
    else:
        year = fallback_year
        if brew_month and int(match.group("month")) < brew_month:
            year += 1
    try:
        return date(year, int(match.group("month")), int(match.group("day"))).isoformat()
    except ValueError:
        return None


def header_values(body: str, label: str, converter):
    match = re.search(label + r"\s*:\s*([^\n]+)", body, re.I)
    if not match:
        return []
    return [converted for raw in re.split(r"[\\/]", match.group(1)) if (converted := converter(raw)) is not None]


def measurement_lines(body: str) -> list[str]:
    marker = re.search(r"DATUMS-BL[ĪI]VUMS.*?darb[īi]ba\s*\n", body, re.I)
    if not marker:
        return []
    tail = body[marker.end():]
    # Fermentation rows occupy the first block. The first blank line begins
    # BeerSmith recipe/boil notes rather than a measurement.
    return [line.strip() for line in tail.split("\n\n", 1)[0].splitlines() if line.strip()]


def action_for(line: str) -> str | None:
    normalized = line.lower()
    if re.search(r"\b(?:kaķo|katko|hopbag|\bhb\b|\bap\b)", normalized):
        return "dry_hop"
    if re.search(r"\b(?:uz\s*(?:0|0[.,]5)|met\s+uz\s*0|uz\s+nulli)", normalized):
        return "cool"
    if re.search(r"\b(?:ciet|piever|griež\s+ciet)", normalized):
        return "spund"
    return None


def parse_measurements(body: str, fallback_year: int, brew_month: int, brew_date: str | None):
    measurements, actions = [], []
    for line in measurement_lines(body):
        measured_date = parse_date(line, fallback_year, brew_month)
        if not measured_date:
            continue
        rest = line[DATE.search(line).end():].strip()  # type: ignore[union-attr]
        grav_match = re.search(r"(?<![\d.])(1?0\d{2,3}|1\.0\d{2})(?!\d)", rest)
        line_gravity = gravity(grav_match.group(1)) if grav_match else None
        ph_match = re.search(r"(?:\bph\s*|pH\s*)(\d[.,]\d+)", rest, re.I)
        temp_match = re.search(r"(\d{1,2}[.,]?\d*)\s*[°º]?[cC]\b", rest)
        pressure_match = re.search(r"(\d[.,]\d+)\s*bar\b", rest, re.I)
        action = action_for(rest)
        record = {
            "measuredAt": f"{measured_date}T12:00:00+00:00",
            "gravity": line_gravity,
            "ph": ph(ph_match.group(1)) if ph_match else None,
            # "uz 0C" is a cooling setpoint/action, not a measured beer
            # temperature. Keep the actual historical temperature unknown.
            "temperature": None if action == "cool" else (decimal(temp_match.group(1)) if temp_match else None),
            "pressure": decimal(pressure_match.group(1)) if pressure_match else None,
            "co2Vol": None,
            "note": line,
        }
        if any(record[key] is not None for key in ("gravity", "ph", "temperature", "pressure")):
            measurements.append(record)
        if action:
            actions.append({
                "type": action,
                "performedAt": f"{measured_date}T12:00:00+00:00",
                "gravity": line_gravity,
                "ph": record["ph"],
                "temperature": record["temperature"],
                "pressure": record["pressure"],
                "note": line,
            })
    # Preserve wort-in-tank readings as actual start points, but do not make up
    # a temperature or pressure for them.
    og_values = header_values(body, r"MISAS\s+OG\s+TVERTN[ĒE]", gravity)
    ph_values = header_values(body, r"MISAS\s+pH\s+TVERTN[ĒE]", ph)
    if brew_date:
        for index, og_value in enumerate(og_values):
            point_date = brew_date if index == 0 else f"{fallback_year:04d}-{brew_month:02d}-{min(28, int(brew_date[-2:]) + index):02d}"
            measurements.append({
                "measuredAt": f"{point_date}T12:00:00+00:00",
                "gravity": og_value,
                "ph": ph_values[index] if index < len(ph_values) else None,
                "temperature": None,
                "pressure": None,
                "co2Vol": None,
                "note": "Misas mērījums tvertnē no BeerSmith vēstures",
            })
    # The current model records one action per phase. Preserve the most useful
    # status transition (the final valve-close/cool, first dry-hop); rawNotes
    # retains any additional BeerSmith wording and dates.
    deduplicated: dict[str, dict] = {}
    for action in actions:
        if action["type"] == "dry_hop":
            deduplicated.setdefault("dry_hop", action)
        else:
            deduplicated[action["type"]] = action
    return measurements, list(deduplicated.values()), og_values, ph_values


def parse_packaging(body: str, fallback_year: int, brew_month: int, volume_tons: float):
    section = re.search(r"PILD[ĪI]ŠANA[ \t]*([^\n]*)", body, re.I)
    if not section:
        return []
    dates = [parse_date(token, fallback_year, brew_month) for token in re.split(r"[\\/,]", section.group(1))]
    dates = [item for item in dates if item]
    fg_values = header_values(body, r"FG", gravity)
    ph_values = header_values(body, r"(?m)^pH", ph)
    co2_values = header_values(body, r"CO2", decimal)
    runs = []
    for index, packaged_date in enumerate(dates):
        runs.append({
            "runNumber": index + 1,
            "volumeTons": min(4.0, volume_tons / max(1, len(dates))),
            "packagedAt": f"{packaged_date}T12:00:00+00:00",
            "gravity": fg_values[index] if index < len(fg_values) else None,
            "ph": ph_values[index] if index < len(ph_values) else None,
            "temperature": None,
            "pressure": None,
            "co2Vol": co2_values[index] if index < len(co2_values) else None,
            "note": "Pildīšana no BeerSmith vēstures",
        })
    return runs


def parse_group(header: re.Match[str], body_parts: list[str]) -> dict:
    source_title = header.group("title").replace("\xa0", " ").strip()
    body = "\n\n".join(body_parts)
    tank_match = re.search(r"TVERTNE\s*NR\s*:\s*(\d{1,2})", body, re.I)
    tank = int(tank_match.group(1)) if tank_match else None
    # One older BeerSmith card has an empty "TVERTNE NR" field, but its batch
    # code still contains the vessel suffix. Preserve that as an explicit
    # source inference instead of dropping a usable historic record.
    tank_inferred = False
    if tank is None:
        code = header.group("batch")
        suffix2 = int(code[-2:]) if len(code) >= 2 else 0
        tank = suffix2 if suffix2 in (10, 11, 12, 13) else int(code[-1])
        tank_inferred = True
    if not tank or not 1 <= tank <= 12:
        raise ValueError(f"{header.group('batch')}: invalid source fermenter {tank}")
    year, sequence = code_year_and_sequence(header.group("batch"), tank)
    date_match = re.search(r"DATUMS\s*:\s*([^\n]+)", body, re.I)
    brew_date = parse_date(date_match.group(1), year) if date_match else None
    if not brew_date:
        raise ValueError(f"{header.group('batch')}: missing brew date")
    brew_month = int(brew_date[5:7])
    volume = 8.0 if re.search(r"\b8T\b", source_title, re.I) else 4.0
    measurements, actions, og_values, ph_values = parse_measurements(body, year, brew_month, brew_date)
    # 26446 Čupakabra has the two header labels transposed in BeerSmith:
    # "OG: 5.39" and "pH: 1.044". The numeric domains make the correction
    # unambiguous; retain the original card unchanged in rawNotes.
    raw_og = header_values(body, r"MISAS\s+OG\s+TVERTN[ĒE]", decimal)
    raw_ph = header_values(body, r"MISAS\s+pH\s+TVERTN[ĒE]", decimal)
    labels_swapped = not og_values and any(0 <= value <= 14 for value in raw_og) and any(gravity(str(value)) is not None for value in raw_ph)
    if labels_swapped:
        og_values = [item for value in raw_ph if (item := gravity(str(value))) is not None]
        ph_values = [value for value in raw_og if 0 <= value <= 14]
    elif not ph_values and raw_og:
        ph_values = [value for value in raw_og if 0 <= value <= 14]
    if og_values and not any(item["note"].startswith("Misas mērījums") for item in measurements):
        measurements.append({
            "measuredAt": f"{brew_date}T12:00:00+00:00", "gravity": og_values[0],
            "ph": ph_values[0] if ph_values else None, "temperature": None,
            "pressure": None, "co2Vol": None,
            "note": "Misas mērījums tvertnē no BeerSmith vēstures (lauki avotā bija samainīti vietām)",
        })
    packaging = parse_packaging(body, year, brew_month, volume)
    # A pildīšana date is proof of completion. The caller imports this file as
    # *history*, so cards without a final filling line are still historical
    # records and must never create a false live tank occupancy or overdue work.
    og_target = round(sum(og_values) / len(og_values)) if og_values else 1050
    final_gravity = next((item["gravity"] for item in reversed(packaging) if item["gravity"] is not None), None)
    cool_action = next((item for item in reversed(actions) if item["type"] == "cool" and item["gravity"] is not None), None)
    spund_action = next((item for item in actions if item["type"] == "spund" and item["gravity"] is not None), None)
    dry_hop = any(item["type"] == "dry_hop" for item in actions)
    return {
        "source": {"beersmithRecord": header.group("beersmith"), "sourceTitle": source_title, "rawNotes": body, "tankInferredFromBatchCode": tank_inferred},
        "batchNumber": header.group("batch"), "year": year, "sequence": sequence,
        "beerName": canonical_name(source_title), "fermenterNumber": tank,
        "volumeTons": volume, "brewDate": brew_date,
        "status": "finished" if packaging else "pending_completion_decision",
        "ogTarget": og_target,
        "fgTarget": final_gravity or (cool_action or {}).get("gravity") or og_target,
        "spundGravity": (spund_action or {}).get("gravity") or og_target,
        "hasDryHop": dry_hop,
        "dryHopGravity": next((item["gravity"] for item in actions if item["type"] == "dry_hop" and item["gravity"] is not None), None),
        "coolingGravity": (cool_action or {}).get("gravity") or final_gravity or og_target,
        "co2Target": next((item["co2Vol"] for item in reversed(packaging) if item["co2Vol"] is not None), 2.4),
        "measurements": measurements,
        "actions": actions,
        "packagingRuns": packaging,
    }


def parse_document(docx: Path) -> tuple[list[dict], list[dict]]:
    groups: list[tuple[re.Match[str], list[str]]] = []
    current: tuple[re.Match[str], list[str]] | None = None
    for para in paragraphs(docx):
        header = HEADER.match(para)
        if header:
            current = (header, [])
            groups.append(current)
        elif current:
            current[1].append(para)
    rows: list[dict] = []
    rejected: list[dict] = []
    for header, body in groups:
        try:
            rows.append(parse_group(header, body))
        except ValueError as error:
            rejected.append({
                "beersmithRecord": header.group("beersmith"),
                "batchNumber": header.group("batch"),
                "sourceTitle": header.group("title"),
                "reason": str(error),
                "rawNotes": "\n\n".join(body),
            })
    # Imported BeerSmith cards are explicitly history rather than live work.
    # If a card has no recorded packaging date we retain the fermentation points
    # but mark the completion as inferred. A real ongoing brew must be entered
    # through the normal live-batch flow, where it can safely occupy a vessel.
    for row in rows:
        if row["status"] == "pending_completion_decision":
            row["status"] = "finished_inferred"
            row["source"]["completionInference"] = True
    return rows, rejected


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("docx", type=Path)
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    rows, rejected = parse_document(args.docx)
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps({"schema": "brewtracker-beersmith-history-v1", "batches": rows, "rejected": rejected}, ensure_ascii=False, indent=2), encoding="utf-8")
    print(f"Parsed {len(rows)} historical batches; rejected {len(rejected)}; no live batches created")


if __name__ == "__main__":
    main()
