import argparse
import asyncio
import json
import os
import shlex
import struct
import sys
import time
from datetime import datetime
from pathlib import Path
from typing import Any

VENDORED_SITE = Path(__file__).resolve().parent / ".venv-puffco" / "Lib" / "site-packages"
if VENDORED_SITE.exists():
    sys.path.insert(0, str(VENDORED_SITE))

from puffcoble import PuffcoBLE


DEFAULT_DEVICE = os.environ.get("PUFFCO_DEVICE", "Peak")
DEFAULT_MAC = os.environ.get("PUFFCO_MAC")
HEAT_STATES = {"HEAT_CYCLE_PREHEAT", "HEAT_CYCLE_ACTIVE", "HEAT_CYCLE_FADE"}
READ_TYPES = ("bytes", "float32", "int16", "uint16", "int32", "uint32", "uint8", "int8", "bool")
WRITE_TYPES = ("bytes", "text", "float32", "int16", "uint16", "int32", "uint32", "uint8", "int8", "bool")
PROFILE_COUNT = 4
DAB_PATHS = (
    "/p/app/info/dtot",
    "/p/app/info/dtotl",
    "/p/app/info/dt",
    "/p/app/info/dabs",
    "/p/app/info/dab",
    "/p/app/info/dcnt",
    "/p/app/info/dcntl",
    "/p/app/info/dcount",
    "/p/app/info/hcnt",
    "/p/app/info/hits",
    "/p/app/stat/dtot",
    "/p/app/stat/dabs",
    "/p/app/stat/dab",
    "/p/app/stat/dcnt",
    "/p/app/stat/hcnt",
    "/p/app/stat/hits",
    "/p/app/dtot",
    "/p/app/dabs",
    "/p/app/dab",
    "/p/app/dcnt",
    "/p/app/hcnt",
    "/p/app/hits",
    "/u/app/info/dtot",
    "/u/app/info/dabs",
    "/u/app/info/dcnt",
    "/u/app/dtot",
    "/u/app/dabs",
    "/u/app/dcnt",
)
DAB_SCAN_SIZE = 12
KNOWN_USAGE_PATHS = (
    "/p/app/info/dpd",
    "/p/app/info/drem",
)
APP_INFO_KEYS = (
    "dpd",
    "drem",
    "dtot",
    "dtotl",
    "dabs",
    "dab",
    "dcnt",
    "dcntl",
    "dcount",
    "hcnt",
    "hits",
    "tot",
    "total",
    "cnt",
    "count",
    "use",
    "uses",
    "usage",
    "ses",
    "sess",
    "sessions",
    "cyc",
    "cycle",
    "cycles",
    "heat",
    "heats",
    "htot",
    "tdab",
    "tdabs",
    "tdcnt",
)
APP_INFO_PREFIXES = (
    "/p/app/info",
    "/p/app/stat",
    "/p/app",
    "/u/app/info",
    "/u/app",
)
BASELINE_PATHS = (
    ("/u/sys/name", 32),
    ("/p/sys/fw/ver", 12),
    ("/p/app/stat/id", 1),
    ("/p/bat/cap", 4),
)


def fmt(value: Any) -> str:
    if value is None:
        return "n/a"
    if hasattr(value, "name"):
        try:
            return f"{value.name} ({int(value)})"
        except Exception:
            return str(value.name)
    if isinstance(value, (bytes, bytearray)):
        return bytes(value).hex(" ")
    return str(value)


def compact(value: Any, *, limit: int = 80) -> str:
    text = fmt(value)
    if len(text) <= limit:
        return text
    return f"{text[:limit - 3]}..."


def json_default(value: Any) -> str:
    return fmt(value)


def pretty(value: Any) -> str:
    try:
        return json.dumps(value, indent=2, sort_keys=True, default=json_default)
    except TypeError:
        return fmt(value)


def state_name(value: Any) -> str:
    return str(value.name) if hasattr(value, "name") else str(value)


def heat_status(value: Any) -> str:
    name = state_name(value)
    if name in HEAT_STATES:
        return "HEATING"
    if name in {"IDLE", "SLEEP", "MASTER_OFF"}:
        return "idle"
    return "other"


def byte_value(value: str) -> int:
    number = int(value)
    if not 0 <= number <= 255:
        raise argparse.ArgumentTypeError("value must be 0-255")
    return number


def profile_index(value: str) -> int:
    index = int(value)
    if not 0 <= index < PROFILE_COUNT:
        raise argparse.ArgumentTypeError(f"profile index must be 0-{PROFILE_COUNT - 1}")
    return index


def temp_f_value(value: str) -> float:
    temp = float(value)
    if not 250 <= temp <= 700:
        raise argparse.ArgumentTypeError("temperature must be 250-700 F")
    return temp


def seconds_value(value: str) -> float:
    seconds = float(value)
    if not 5 <= seconds <= 180:
        raise argparse.ArgumentTypeError("time must be 5-180 seconds")
    return seconds


def profile_name_bytes(value: str) -> bytes:
    encoded = value.encode("utf-8")
    if len(encoded) > 31:
        raise argparse.ArgumentTypeError("profile name must fit in 31 UTF-8 bytes")
    return encoded + b"\x00" * (32 - len(encoded))


def profile_colour(value: Any) -> Any:
    if isinstance(value, str):
        return {"lamp": {"name": "solid", "param": {"color": [hex_color(value)]}}}
    return value


def write_payload(data_type: str, value: str) -> bytes:
    if data_type == "bytes":
        text = value.replace(" ", "")
        if len(text) % 2:
            raise argparse.ArgumentTypeError("hex byte input must have an even number of digits")
        try:
            return bytes.fromhex(text)
        except ValueError as exc:
            raise argparse.ArgumentTypeError("bytes input must be hex, like 01ff or '01 ff'") from exc
    if data_type == "text":
        return value.encode("utf-8")
    if data_type == "bool":
        lowered = value.lower()
        if lowered in {"1", "true", "yes", "on"}:
            return struct.pack("<?", True)
        if lowered in {"0", "false", "no", "off"}:
            return struct.pack("<?", False)
        raise argparse.ArgumentTypeError("bool value must be true/false, yes/no, on/off, or 1/0")

    formats = {
        "int8": "b",
        "uint8": "B",
        "int16": "h",
        "uint16": "H",
        "int32": "i",
        "uint32": "I",
        "float32": "f",
    }
    number: int | float
    number = float(value) if data_type == "float32" else int(value, 0)
    try:
        return struct.pack(f"<{formats[data_type]}", number)
    except struct.error as exc:
        raise argparse.ArgumentTypeError(str(exc)) from exc


def hex_color(value: str) -> str:
    color = value.strip()
    if not color.startswith("#"):
        color = f"#{color}"
    if len(color) != 7:
        raise argparse.ArgumentTypeError("color must look like #RRGGBB")
    try:
        int(color[1:], 16)
    except ValueError as exc:
        raise argparse.ArgumentTypeError("color must use hex digits") from exc
    return color.lower()


async def safe(label: str, call, *, quiet: bool = False) -> Any:
    try:
        value = await call()
        if not quiet:
            print(f"{label}: {fmt(value)}")
        return value
    except Exception as exc:
        if not quiet:
            print(f"{label}: FAILED - {type(exc).__name__}: {exc}")
        return None


def connect_hint(exc: Exception) -> str | None:
    message = str(exc).lower()
    winerror = getattr(exc, "winerror", None)
    if winerror == -2147023673 or "operation was canceled by the user" in message:
        return (
            "Windows canceled the BLE connect before Puffco auth. Close the Puffco "
            "mobile app, make sure the device is awake and nearby, then retry; if it "
            "keeps happening, toggle Bluetooth or use --retry-delay 15."
        )
    if "device not found" in message:
        return "No matching advertisement was seen. Wake the device and keep it close while scanning."
    return None


async def connect(args) -> PuffcoBLE:
    target = args.mac or args.device
    attempts = 1 if getattr(args, "quick", False) else max(1, args.retries + 1)
    connect_timeout = min(args.connect_timeout, 15) if getattr(args, "quick", False) else args.connect_timeout
    quiet = getattr(args, "json", False)
    last_error = None

    for attempt in range(1, attempts + 1):
        suffix = f" ({attempt}/{attempts})" if attempts > 1 else ""
        if not quiet:
            print(f"Connecting to {target!r}{suffix}...")
        device = PuffcoBLE(
            device_name=None if args.mac else args.device,
            device_mac=args.mac,
            debug=args.debug,
        )
        try:
            await asyncio.wait_for(device.connect(), timeout=connect_timeout)
            if not quiet:
                print("Connected.")
            return device
        except Exception as exc:
            last_error = exc
            await disconnect(device, quiet=True)
            if not quiet:
                print(f"Connect failed: {type(exc).__name__}: {exc}")
            hint = connect_hint(exc)
            if hint and not quiet:
                print(f"Hint: {hint}")
            if attempt < attempts and not quiet:
                print(f"Waiting {args.retry_delay:g}s before retry...")
            if attempt < attempts:
                await asyncio.sleep(args.retry_delay)

    raise RuntimeError(f"Could not connect after {attempts} attempt(s)") from last_error


async def disconnect(device: PuffcoBLE, *, quiet: bool = False) -> None:
    try:
        await device.disconnect()
        if not quiet:
            print("Disconnected.")
    except Exception as exc:
        if not quiet:
            print(f"Disconnect failed: {type(exc).__name__}: {exc}")


async def raw_uint32(device: PuffcoBLE, path: str) -> int | None:
    raw = await device.read_short(path, 0, 4)
    if len(raw) == 0:
        return None
    if len(raw) < 4:
        raise ValueError(f"{path} returned only {len(raw)} byte(s): {fmt(raw)}")
    return struct.unpack("<I", bytes(raw[:4]))[0]


async def raw_float(device: PuffcoBLE, path: str) -> int | None:
    raw = await device.read_short(path, 0, 4)
    if len(raw) == 0:
        return None
    if len(raw) < 4:
        raise ValueError(f"{path} returned only {len(raw)} byte(s): {fmt(raw)}")
    return int(struct.unpack("<f", bytes(raw[:4]))[0])


def metric_values(raw: bytes | bytearray) -> str:
    raw_bytes = bytes(raw)
    values = [f"raw={fmt(raw_bytes)}"]

    if len(raw_bytes) == 1:
        values.append(f"uint8={raw_bytes[0]}")

    if len(raw_bytes) >= 4:
        first4 = raw_bytes[:4]
        values.append(f"uint32={struct.unpack('<I', first4)[0]}")
        values.append(f"float32={struct.unpack('<f', first4)[0]:.2f}")

    text = raw_bytes.rstrip(b"\x00")
    if text and all(32 <= b < 127 for b in text):
        values.append(f"ascii={text.decode('ascii')!r}")

    return "  ".join(values)


def dedupe(items) -> list[str]:
    seen = set()
    result = []
    for item in items:
        if item in seen:
            continue
        seen.add(item)
        result.append(item)
    return result


async def scan_candidate_paths(
    device: PuffcoBLE,
    paths,
    *,
    size: int,
    show_misses: bool = False,
) -> int:
    hits = 0
    for path in paths:
        try:
            raw = await device.read_short(path, 0, size)
        except Exception as exc:
            if show_misses:
                print(f"{path:24} FAILED - {type(exc).__name__}: {exc}")
            continue

        if raw:
            hits += 1
            print(f"{path:24} {metric_values(raw)}")
        elif show_misses:
            print(f"{path:24} no data")

    return hits


async def total_dabs(device: PuffcoBLE, preferred_path: str | None = None) -> int | None:
    paths = (preferred_path,) if preferred_path else DAB_PATHS
    for path in paths:
        try:
            value = await raw_uint32(device, path)
        except Exception:
            value = None
        if value is not None:
            return value
    return None


async def profile_record(device: PuffcoBLE, index: int, current: int | None = None) -> dict[str, Any]:
    if current is None:
        current = await safe("", device.get_current_profile, quiet=True)
    return {
        "index": index,
        "active": current == index,
        "name": await safe("", lambda: device.get_profile_name(index), quiet=True),
        "temp_f": await safe("", lambda: device.get_profile_temp(index), quiet=True),
        "time_s": await safe("", lambda: device.get_profile_time(index), quiet=True),
        "color": await safe("", lambda: device.get_profile_colours(index), quiet=True),
    }


async def apply_profile_record(
    device: PuffcoBLE,
    index: int,
    record: dict[str, Any],
    *,
    select: bool = False,
) -> list[str]:
    changed = []
    if record.get("name") is not None:
        await device.write_short(
            f"/u/app/hc/{index}/name",
            0,
            0,
            profile_name_bytes(str(record["name"])),
        )
        changed.append("name")
    if record.get("temp_f") is not None:
        temp_c = (float(record["temp_f"]) - 32) / 1.8
        await device.write_short(
            f"/u/app/hc/{index}/temp",
            0,
            0,
            struct.pack("<f", temp_c),
        )
        changed.append("temp")
    if record.get("time_s") is not None:
        await device.write_short(
            f"/u/app/hc/{index}/time",
            0,
            0,
            struct.pack("<f", float(record["time_s"])),
        )
        changed.append("time")
    if record.get("color") is not None:
        await device.set_profile_colour(index, colour=profile_colour(record["color"]))
        changed.append("color")
    if select:
        await device.set_current_profile(index)
        changed.append("selected")
    return changed


async def snapshot(device: PuffcoBLE, args, *, quiet: bool = False) -> dict[str, Any]:
    if not quiet:
        print(f"\nSnapshot {datetime.now().strftime('%H:%M:%S')}")
    data: dict[str, Any] = {}

    data["name"] = await safe("Device", device.get_device_name, quiet=quiet)
    data["serial"] = await safe("Serial", device.get_serial_number, quiet=quiet)
    data["firmware"] = await safe("Firmware", device.get_software_version, quiet=quiet)
    data["battery"] = await safe("Battery %", device.get_battery_level, quiet=quiet)
    data["charge"] = await safe("Charge", device.get_battery_charge_state, quiet=quiet)
    data["chamber"] = await safe("Chamber", device.get_chamber_type, quiet=quiet)
    data["state"] = await safe("State", device.get_operating_state, quiet=quiet)
    data["heat"] = heat_status(data["state"])
    if not quiet:
        print(f"Heat: {data['heat']}")

    data["total_dabs"] = await safe("Total dabs", lambda: total_dabs(device, args.dab_path), quiet=quiet)
    data["dabs_per_day"] = await safe("Dabs/day", lambda: raw_float(device, "/p/app/info/dpd"), quiet=quiet)
    data["dabs_left"] = await safe("Approx dabs left", lambda: raw_float(device, "/p/app/info/drem"), quiet=quiet)

    data["profile"] = await safe("Profile #", device.get_current_profile, quiet=quiet)
    data["profile_name"] = await safe("Profile name", device.get_profile_name, quiet=quiet)
    data["target_f"] = await safe("Target temp F", device.get_profile_temp, quiet=quiet)
    data["time_s"] = await safe("Profile time sec", device.get_profile_time, quiet=quiet)

    return data


async def monitor_loop(device: PuffcoBLE, args, seconds: float | None) -> None:
    end = None if seconds is None else asyncio.get_running_loop().time() + seconds
    print("\ntime     state                 heat     targetF dabs")

    while end is None or asyncio.get_running_loop().time() < end:
        state = await safe("", device.get_operating_state, quiet=True)
        target = await safe("", device.get_profile_temp, quiet=True)
        dabs = await safe("", lambda: total_dabs(device, args.dab_path), quiet=True)
        print(
            f"{datetime.now().strftime('%H:%M:%S')}  "
            f"{fmt(state):20.20} {heat_status(state):8.8} "
            f"{fmt(target):>7} {fmt(dabs):>4}"
        )
        if getattr(args, "stop_when_idle", False) and state_name(state) not in HEAT_STATES:
            break
        await asyncio.sleep(args.poll)


async def find(args) -> None:
    device = PuffcoBLE(device_name=None if args.mac else args.device, device_mac=args.mac, debug=args.debug)
    found = await asyncio.wait_for(device.search_for_device(), timeout=args.connect_timeout)
    if not found:
        raise RuntimeError("No matching Puffco advertisement found")
    print(f"Found: {found.name or 'unknown'} / {found.address or 'unknown'}")


async def doctor(args) -> None:
    target = args.mac or args.device
    print(f"BLE doctor for {target!r}")
    device = PuffcoBLE(device_name=None if args.mac else args.device, device_mac=args.mac, debug=args.debug)

    scan_start = time.perf_counter()
    found = await asyncio.wait_for(device.search_for_device(), timeout=args.connect_timeout)
    scan_elapsed = time.perf_counter() - scan_start
    if not found:
        print(f"Scan: no matching advertisement after {scan_elapsed:.1f}s")
        print("Hint: wake the device, keep it close, and close the Puffco mobile app.")
        return

    print(f"Scan: found {found.name or 'unknown'} / {found.address or 'unknown'} in {scan_elapsed:.1f}s")

    args.quick = False
    connect_start = time.perf_counter()
    connected = await connect(args)
    connect_elapsed = time.perf_counter() - connect_start
    try:
        print(f"Connect/auth: ok in {connect_elapsed:.1f}s")
        print("Baseline Lorax reads:")
        ok = 0
        for path, size in BASELINE_PATHS:
            try:
                raw = await connected.read_short(path, 0, size)
            except Exception as exc:
                print(f"{path:22} FAILED - {type(exc).__name__}: {exc}")
                continue
            if raw:
                ok += 1
                print(f"{path:22} {fmt(raw)}")
            else:
                print(f"{path:22} no data")
        print(f"Baseline readable paths: {ok}/{len(BASELINE_PATHS)}")
        if ok == len(BASELINE_PATHS):
            print("Doctor result: BLE scan, auth, and basic reads look healthy.")
        else:
            print("Doctor result: connected, but some basic Lorax reads failed or returned empty.")
    finally:
        await disconnect(connected)


async def info(args) -> None:
    device = await connect(args)
    try:
        data = await snapshot(device, args, quiet=args.json)
        if args.full:
            details = {
                "product": await safe("", lambda: device.get_device_info(), quiet=True),
                "bootloader": await safe("", device.get_bootloader_version, quiet=True),
                "uptime_raw": await safe("", device.get_uptime, quiet=True),
            }
            data["details"] = details
            if not args.json:
                print("\nDevice details:")
                print(pretty(details))
        if args.json:
            print(pretty(data))
    finally:
        await disconnect(device, quiet=args.json)


async def about(args) -> None:
    device = await connect(args)
    try:
        data = {
            "product": await safe("", device.get_device_info, quiet=True),
            "name": await safe("", device.get_device_name, quiet=True),
            "serial": await safe("", device.get_serial_number, quiet=True),
            "firmware": await safe("", device.get_software_version, quiet=True),
            "bootloader": await safe("", device.get_bootloader_version, quiet=True),
            "uptime_raw": await safe("", device.get_uptime, quiet=True),
            "chamber": await safe("", device.get_chamber_type, quiet=True),
        }

        if args.json:
            print(pretty(data))
        else:
            print(f"Name: {fmt(data['name'])}")
            print(f"Serial: {fmt(data['serial'])}")
            print(f"Firmware: {fmt(data['firmware'])}")
            print(f"Bootloader: {fmt(data['bootloader'])}")
            print(f"Chamber: {fmt(data['chamber'])}")
            print(f"Uptime raw: {fmt(data['uptime_raw'])}")
            print("Product:")
            print(pretty(data["product"]))
    finally:
        await disconnect(device, quiet=args.json)


async def monitor(args) -> None:
    device = await connect(args)
    try:
        await monitor_loop(device, args, args.seconds)
    finally:
        await disconnect(device)


async def heat(args) -> None:
    device = await connect(args)
    try:
        current = {} if args.fast else await snapshot(device, args)
        if not args.yes:
            print("\nDry run. Add --yes to start heat.")
            return

        print("\nStarting heat...")
        await device.start_heat_cycle()
        for _ in range(max(1, round(args.confirm_seconds / args.poll))):
            state = await safe("", device.get_operating_state, quiet=True)
            print(f"Confirm: {fmt(state)} / {heat_status(state)}")
            if state_name(state) in HEAT_STATES:
                break
            await asyncio.sleep(args.poll)

        if not args.no_monitor:
            seconds = args.monitor_seconds or (float(current.get("time_s") or 90) + 20)
            await monitor_loop(device, args, seconds)
    finally:
        await disconnect(device)


async def device_power(args) -> None:
    device = await connect(args)
    try:
        if args.power_cmd == "sleep":
            await device.enter_sleep_mode()
            print("Sleep command sent.")
        elif args.power_cmd == "off":
            await device.power_off()
            print("Power-off command sent.")
        elif args.power_cmd == "factory-reset":
            if not args.yes:
                print("Dry run. Add --yes to factory reset.")
                return
            await device.factory_reset()
            print("Factory reset command sent.")
    finally:
        await disconnect(device)


async def stop(args) -> None:
    device = await connect(args)
    try:
        await device.stop_heat_cycle()
        print("Stop sent.")
    finally:
        await disconnect(device)


async def boost(args) -> None:
    device = await connect(args)
    try:
        await device.boost_heat_cycle()
        print("Boost sent.")
    finally:
        await disconnect(device)


async def lighting(args) -> None:
    device = await connect(args)
    try:
        if args.light_cmd == "lantern":
            if args.state == "on":
                await device.start_lantern()
            else:
                await device.stop_lantern()
            print(f"Lantern {args.state} sent.")

        elif args.light_cmd == "stealth":
            await device.set_stealth_mode(args.state == "on")
            current = await safe("Stealth mode", device.is_stealth_mode)
            print(f"Stealth {args.state} sent. Current: {fmt(current)}")

        elif args.light_cmd == "brightness":
            await device.set_led_brightness(args.base, args.mid, args.glass, args.logo)
            print(f"Brightness sent: base={args.base} mid={args.mid} glass={args.glass} logo={args.logo}")

        elif args.light_cmd == "profile-color":
            await device.set_profile_colour(args.index, colour=profile_colour(args.color))
            target = "current profile" if args.index is None else f"profile {args.index}"
            print(f"Set {target} color to {args.color}.")

        elif args.light_cmd == "show-battery":
            await device.show_battery_level()
            print("Show battery light command sent.")

        elif args.light_cmd == "show-version":
            await device.show_version()
            print("Show version light command sent.")
    finally:
        await disconnect(device)


async def profiles(args) -> None:
    if args.profile_cmd == "restore":
        payload = json.loads(Path(args.file).read_text(encoding="utf-8"))
        if isinstance(payload, dict):
            records = payload.get("profiles", [payload])
            selected = payload.get("current_profile")
        elif isinstance(payload, list):
            records = payload
            selected = None
        else:
            raise ValueError("restore file must contain a profile object, a profile list, or an export object")
        if isinstance(records, dict):
            records = [records]
        if not isinstance(records, list):
            raise ValueError("restore profiles must be a list or object")
        if not args.yes:
            print(f"Dry run. Would restore {len(records)} profile(s) from {args.file}. Add --yes to send.")
            return

        device = await connect(args)
        try:
            for record in records:
                index = profile_index(str(record["index"]))
                should_select = args.select_active and (
                    selected == index or (selected is None and record.get("active") is True)
                )
                changed = await apply_profile_record(
                    device,
                    index,
                    record,
                    select=should_select,
                )
                print(f"Restored profile {index}: {', '.join(changed) or 'no fields'}.")
        finally:
            await disconnect(device)
        return

    if args.profile_cmd == "export" and not args.output:
        args.json = True

    device = await connect(args)
    try:
        if args.profile_cmd == "list":
            current = await safe("", device.get_current_profile, quiet=True)
            indexes = args.index if args.index else range(PROFILE_COUNT)
            records = [await profile_record(device, index, current) for index in indexes]
            if args.json:
                print(pretty({"current_profile": current, "profiles": records}))
                return
            print("idx active name                 tempF timeS color")
            for record in records:
                active = "*" if record["active"] else ""
                print(
                    f"{record['index']:>3} {active:^6} "
                    f"{compact(record['name'], limit=20):20.20} "
                    f"{compact(record['temp_f'], limit=5):>5} "
                    f"{compact(record['time_s'], limit=5):>5} "
                    f"{compact(record['color'], limit=70)}"
                )
        elif args.profile_cmd == "current":
            index = await safe("Current profile", device.get_current_profile)
            await safe("Profile name", lambda: device.get_profile_name(index))
            await safe("Profile temp F", lambda: device.get_profile_temp(index))
            await safe("Profile time sec", lambda: device.get_profile_time(index))
            await safe("Profile color", lambda: device.get_profile_colours(index))
        elif args.profile_cmd == "select":
            await device.set_current_profile(args.index)
            print(f"Selected profile {args.index}.")
        elif args.profile_cmd == "set":
            record = {
                "name": args.name,
                "temp_f": args.temp,
                "time_s": args.time,
                "color": args.color,
            }
            changed = await apply_profile_record(device, args.index, record, select=args.select)
            if changed:
                print(f"Updated profile {args.index}: {', '.join(changed)}.")
            else:
                print("Nothing to update. Add --name, --temp, --time, --color, or --select.")
        elif args.profile_cmd == "color":
            await device.set_profile_colour(args.index, colour=profile_colour(args.color))
            target = "current profile" if args.index is None else f"profile {args.index}"
            print(f"Set {target} color to {args.color}.")
        elif args.profile_cmd == "export":
            current = await safe("", device.get_current_profile, quiet=True)
            indexes = args.index if args.index else range(PROFILE_COUNT)
            records = [await profile_record(device, index, current) for index in indexes]
            payload = {
                "exported_at": datetime.now().isoformat(timespec="seconds"),
                "current_profile": current,
                "profiles": records,
            }
            text = pretty(payload)
            if args.output:
                Path(args.output).write_text(f"{text}\n", encoding="utf-8")
                print(f"Wrote {len(records)} profile(s) to {args.output}.")
            else:
                print(text)
    finally:
        await disconnect(device, quiet=getattr(args, "json", False))


def session_help() -> None:
    print(
        "Commands: help, info, state, battery, heat, stop, boost, "
        "profiles, profile <0-3>, lantern on|off, stealth on|off, "
        "brightness <base> <mid> <glass> <logo>, color <#rrggbb> [index], "
        "read <path> [size] [type], quit"
    )


async def session_command(device: PuffcoBLE, args, line: str) -> bool:
    parts = shlex.split(line)
    if not parts:
        await snapshot(device, args)
        return True

    cmd_name = parts[0].lower()
    rest = parts[1:]

    if cmd_name in {"q", "quit", "exit"}:
        return False
    if cmd_name in {"h", "help", "?"}:
        session_help()
    elif cmd_name in {"i", "info", "status"}:
        await snapshot(device, args)
    elif cmd_name == "state":
        state = await safe("", device.get_operating_state, quiet=True)
        print(f"State: {fmt(state)} / {heat_status(state)}")
    elif cmd_name == "battery":
        await safe("Battery %", device.get_battery_level)
        await safe("Charge", device.get_battery_charge_state)
    elif cmd_name == "heat":
        await device.start_heat_cycle()
        print("Heat sent.")
    elif cmd_name == "stop":
        await device.stop_heat_cycle()
        print("Stop sent.")
    elif cmd_name == "boost":
        await device.boost_heat_cycle()
        print("Boost sent.")
    elif cmd_name == "profiles":
        current = await safe("", device.get_current_profile, quiet=True)
        print("idx active name                 tempF timeS")
        for index in range(PROFILE_COUNT):
            record = await profile_record(device, index, current)
            active = "*" if record["active"] else ""
            print(
                f"{index:>3} {active:^6} "
                f"{compact(record['name'], limit=20):20.20} "
                f"{compact(record['temp_f'], limit=5):>5} "
                f"{compact(record['time_s'], limit=5):>5}"
            )
    elif cmd_name == "profile":
        if len(rest) != 1:
            print("Usage: profile <0-3>")
        else:
            index = profile_index(rest[0])
            await device.set_current_profile(index)
            print(f"Selected profile {index}.")
    elif cmd_name == "lantern":
        if rest == ["on"]:
            await device.start_lantern()
            print("Lantern on sent.")
        elif rest == ["off"]:
            await device.stop_lantern()
            print("Lantern off sent.")
        else:
            print("Usage: lantern on|off")
    elif cmd_name == "stealth":
        if rest not in (["on"], ["off"]):
            print("Usage: stealth on|off")
        else:
            await device.set_stealth_mode(rest[0] == "on")
            current = await safe("", device.is_stealth_mode, quiet=True)
            print(f"Stealth mode: {fmt(current)}")
    elif cmd_name == "brightness":
        if len(rest) != 4:
            print("Usage: brightness <base> <mid> <glass> <logo>")
        else:
            values = [byte_value(value) for value in rest]
            await device.set_led_brightness(*values)
            print(f"Brightness sent: base={values[0]} mid={values[1]} glass={values[2]} logo={values[3]}")
    elif cmd_name == "color":
        if len(rest) not in (1, 2):
            print("Usage: color <#rrggbb> [index]")
        else:
            index = None if len(rest) == 1 else profile_index(rest[1])
            color = hex_color(rest[0])
            await device.set_profile_colour(index, colour=profile_colour(color))
            target = "current profile" if index is None else f"profile {index}"
            print(f"Set {target} color to {color}.")
    elif cmd_name == "read":
        if not rest:
            print("Usage: read <path> [size] [type]")
        else:
            size = int(rest[1]) if len(rest) >= 2 else None
            data_type = rest[2] if len(rest) >= 3 else "bytes"
            if data_type not in READ_TYPES:
                print(f"Type must be one of: {', '.join(READ_TYPES)}")
            else:
                value = await device.read(rest[0], 0, size=size, data_type=data_type)
                print(fmt(value))
    else:
        print(f"Unknown command: {cmd_name}. Type help.")

    return True


async def session(args) -> None:
    device = await connect(args)
    try:
        print("Connected session. Type help for commands, quit to disconnect.")
        while True:
            line = await asyncio.get_running_loop().run_in_executor(None, input, "puffco> ")
            try:
                keep_going = await session_command(device, args, line)
            except argparse.ArgumentTypeError as exc:
                print(f"Invalid value: {exc}")
                keep_going = True
            except Exception as exc:
                print(f"Command failed: {type(exc).__name__}: {exc}")
                keep_going = True
            if not keep_going:
                return
    finally:
        await disconnect(device)


async def status(args) -> None:
    device = await connect(args)
    try:
        while True:
            await snapshot(device, args)
            cmd = (await asyncio.get_running_loop().run_in_executor(
                None, input, "\n[Enter] refresh | heat | stop | boost | monitor | quit\n> "
            )).strip().lower()

            if cmd in {"q", "quit", "exit"}:
                return
            if cmd == "heat":
                if input("Type YES to heat: ").strip() == "YES":
                    await device.start_heat_cycle()
                    print("Heat sent.")
            elif cmd == "stop":
                await device.stop_heat_cycle()
                print("Stop sent.")
            elif cmd == "boost":
                await device.boost_heat_cycle()
                print("Boost sent.")
            elif cmd == "monitor":
                await monitor_loop(device, args, getattr(args, "seconds", 90))
    finally:
        await disconnect(device)


async def read_path(args) -> None:
    device = await connect(args)
    try:
        value = await device.read(args.path, args.offset, size=args.size, data_type=args.type)
        print(fmt(value))
    finally:
        await disconnect(device)


async def write_path(args) -> None:
    payload = write_payload(args.type, args.value)
    if not args.yes:
        print(f"Dry run. Would write {fmt(payload)} to {args.path} @ offset {args.offset}. Add --yes to send.")
        return

    device = await connect(args)
    try:
        await device.write_short(args.path, args.offset, 0, payload)
        print(f"Wrote {fmt(payload)} to {args.path} @ offset {args.offset}.")
    finally:
        await disconnect(device)


async def dabs_scan(args) -> None:
    device = await connect(args)
    try:
        print("Dab counter scan:")
        print("\nBaseline reads:")
        baseline_hits = 0
        for path, size in BASELINE_PATHS:
            try:
                raw = await device.read_short(path, 0, size)
            except Exception as exc:
                print(f"{path:22} FAILED - {type(exc).__name__}: {exc}")
                continue

            if raw:
                baseline_hits += 1
                print(f"{path:22} {fmt(raw)}")
            else:
                print(f"{path:22} no data")

        print("\nSDK usage helpers:")
        helpers = (
            ("Total dabs", device.get_total_dabs),
            ("Dabs/day", device.get_dabs_per_day),
            ("Approx dabs left", device.get_approx_dabs_remaining),
        )
        for label, call in helpers:
            await safe(label, call)

        if baseline_hits == 0:
            print(
                "\nNo baseline Lorax paths returned data. The dab paths below are "
                "unlikely to work until basic reads do."
            )

        print("\nTotal-counter candidate paths:")
        hits = await scan_candidate_paths(
            device,
            DAB_PATHS,
            size=args.size,
            show_misses=args.show_misses,
        )
        print(f"Readable total-counter candidates: {hits}/{len(DAB_PATHS)}")
        if hits == 0:
            print("No readable total-counter candidate paths found.")

        print("\nKnown usage metric paths:")
        usage_hits = await scan_candidate_paths(
            device,
            KNOWN_USAGE_PATHS,
            size=args.size,
            show_misses=args.show_misses,
        )
        print(f"Readable known usage metric paths: {usage_hits}/{len(KNOWN_USAGE_PATHS)}")
    finally:
        await disconnect(device)


async def app_info_scan(args) -> None:
    device = await connect(args)
    try:
        generated = (
            f"{prefix}/{key}"
            for prefix in APP_INFO_PREFIXES
            for key in APP_INFO_KEYS
        )
        paths = dedupe([*generated, *args.path])
        print(f"App metric scan ({len(paths)} paths, {args.size} byte read):")
        hits = await scan_candidate_paths(
            device,
            paths,
            size=args.size,
            show_misses=args.show_misses,
        )
        print(f"Readable app metric paths: {hits}/{len(paths)}")
        if hits == 0:
            print("No readable app metric paths found.")
    finally:
        await disconnect(device)


async def self_test(args) -> None:
    class S:
        name = "HEAT_CYCLE_ACTIVE"
        def __int__(self): return 8

    assert heat_status(S()) == "HEATING"
    assert profile_index("0") == 0
    assert profile_index("3") == 3
    assert write_payload("bytes", "01 ff") == b"\x01\xff"
    assert write_payload("text", "Peak") == b"Peak"
    assert write_payload("uint8", "255") == b"\xff"
    assert write_payload("float32", "1.5") == struct.pack("<f", 1.5)
    assert parser().parse_args(["doctor"]).cmd == "doctor"
    assert parser().parse_args(["session"]).cmd == "session"
    assert parser().parse_args(["profile", "export"]).profile_cmd == "export"
    assert parser().parse_args(["profile", "restore", "profiles.json"]).profile_cmd == "restore"
    print("Self-test passed.")


def add_common(p: argparse.ArgumentParser, *, after_command: bool = False) -> None:
    default = argparse.SUPPRESS if after_command else None
    p.add_argument("--device", default=DEFAULT_DEVICE if default is None else default)
    p.add_argument("--mac", default=DEFAULT_MAC if default is None else default)
    p.add_argument("--debug", action="store_true", default=False if default is None else default)
    p.add_argument("--connect-timeout", type=float, default=35 if default is None else default)
    p.add_argument("--retries", type=int, default=2 if default is None else default)
    p.add_argument("--retry-delay", type=float, default=8 if default is None else default)
    p.add_argument("--quick", action="store_true", default=False if default is None else default)
    p.add_argument("--poll", type=float, default=2 if default is None else default)
    p.add_argument("--dab-path", default=default, help="Known total-dabs Lorax path, if dabs-scan finds one")


def parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(description="Small Puffco BLE controller")
    add_common(p)

    sub = p.add_subparsers(dest="cmd", required=True)

    def cmd(name: str) -> argparse.ArgumentParser:
        child = sub.add_parser(name)
        add_common(child, after_command=True)
        return child

    cmd("find")
    cmd("doctor")
    info_p = cmd("info")
    info_p.add_argument("--full", action="store_true")
    info_p.add_argument("--json", action="store_true")
    about_p = cmd("about")
    about_p.add_argument("--json", action="store_true")
    status_p = cmd("status")
    status_p.add_argument("--seconds", type=float, default=90)
    cmd("session")
    cmd("stop")
    cmd("boost")

    power = cmd("power")
    power_sub = power.add_subparsers(dest="power_cmd", required=True)

    def power_cmd(name: str) -> argparse.ArgumentParser:
        child = power_sub.add_parser(name)
        add_common(child, after_command=True)
        return child

    power_cmd("sleep")
    power_cmd("off")
    reset = power_cmd("factory-reset")
    reset.add_argument("--yes", action="store_true")

    profile = cmd("profile")
    profile_sub = profile.add_subparsers(dest="profile_cmd", required=True)

    def profile_cmd(name: str) -> argparse.ArgumentParser:
        child = profile_sub.add_parser(name)
        add_common(child, after_command=True)
        return child

    profile_list = profile_cmd("list")
    profile_list.add_argument("--index", type=profile_index, action="append", help="Profile index to show; repeatable")
    profile_list.add_argument("--json", action="store_true")
    profile_cmd("current")
    profile_select = profile_cmd("select")
    profile_select.add_argument("index", type=profile_index)
    profile_set = profile_cmd("set")
    profile_set.add_argument("index", type=profile_index)
    profile_set.add_argument("--name")
    profile_set.add_argument("--temp", type=temp_f_value, help="Target temperature in Fahrenheit")
    profile_set.add_argument("--time", type=seconds_value, help="Profile duration in seconds")
    profile_set.add_argument("--color", type=hex_color)
    profile_set.add_argument("--select", action="store_true", help="Make this profile active after updating")
    profile_color = profile_cmd("color")
    profile_color.add_argument("color", type=hex_color)
    profile_color.add_argument("--index", type=profile_index)
    profile_export = profile_cmd("export")
    profile_export.add_argument("--index", type=profile_index, action="append", help="Profile index to export; repeatable")
    profile_export.add_argument("--output", help="Write backup JSON to this file")
    profile_restore = profile_cmd("restore")
    profile_restore.add_argument("file")
    profile_restore.add_argument("--select-active", action="store_true", help="Restore the exported active profile selection")
    profile_restore.add_argument("--yes", action="store_true")

    light = cmd("light")
    light_sub = light.add_subparsers(dest="light_cmd", required=True)

    def light_cmd(name: str) -> argparse.ArgumentParser:
        child = light_sub.add_parser(name)
        add_common(child, after_command=True)
        return child

    lantern = light_cmd("lantern")
    lantern.add_argument("state", choices=("on", "off"))

    stealth = light_cmd("stealth")
    stealth.add_argument("state", choices=("on", "off"))

    brightness = light_cmd("brightness")
    brightness.add_argument("--base", type=byte_value, required=True)
    brightness.add_argument("--mid", type=byte_value, required=True)
    brightness.add_argument("--glass", type=byte_value, required=True)
    brightness.add_argument("--logo", type=byte_value, required=True)

    color = light_cmd("profile-color")
    color.add_argument("color", type=hex_color)
    color.add_argument("--index", type=profile_index)

    light_cmd("show-battery")
    light_cmd("show-version")

    dabs = cmd("dabs-scan")
    dabs.add_argument("--size", type=int, default=DAB_SCAN_SIZE)
    dabs.add_argument("--show-misses", action="store_true")

    app_scan = cmd("app-info-scan")
    app_scan.add_argument("--size", type=int, default=DAB_SCAN_SIZE)
    app_scan.add_argument("--show-misses", action="store_true")
    app_scan.add_argument("--path", action="append", default=[], help="Extra Lorax path to probe")

    cmd("self-test")

    mon = cmd("monitor")
    mon.add_argument("--seconds", type=float, default=90)
    mon.add_argument("--stop-when-idle", action="store_true")

    h = cmd("heat")
    h.add_argument("--yes", action="store_true")
    h.add_argument("--fast", action="store_true", help="Skip pre-heat snapshot and send the command immediately")
    h.add_argument("--confirm-seconds", type=float, default=12)
    h.add_argument("--monitor-seconds", type=float)
    h.add_argument("--no-monitor", action="store_true")
    h.add_argument("--stop-when-idle", action="store_true")

    r = cmd("read")
    r.add_argument("path")
    r.add_argument("--offset", type=int, default=0)
    r.add_argument("--size", type=int)
    r.add_argument("--type", default="bytes", choices=READ_TYPES)
    w = cmd("write")
    w.add_argument("path")
    w.add_argument("value")
    w.add_argument("--offset", type=int, default=0)
    w.add_argument("--type", default="bytes", choices=WRITE_TYPES)
    w.add_argument("--yes", action="store_true")
    return p


async def main() -> None:
    args = parser().parse_args()
    commands = {
        "find": find,
        "doctor": doctor,
        "info": info,
        "about": about,
        "status": status,
        "session": session,
        "monitor": monitor,
        "heat": heat,
        "stop": stop,
        "boost": boost,
        "power": device_power,
        "profile": profiles,
        "light": lighting,
        "dabs-scan": dabs_scan,
        "app-info-scan": app_info_scan,
        "read": read_path,
        "write": write_path,
        "self-test": self_test,
    }
    try:
        await commands[args.cmd](args)
    except KeyboardInterrupt:
        print("\nInterrupted.")
    except Exception as exc:
        print(f"\nERROR: {type(exc).__name__}: {exc}")
        if args.debug:
            raise
        raise SystemExit(1)


if __name__ == "__main__":
    if sys.platform == "win32" and sys.version_info < (3, 14):
        asyncio.set_event_loop_policy(asyncio.WindowsProactorEventLoopPolicy())
    asyncio.run(main())
