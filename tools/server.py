"""
Single-file Puffco BLE web controller.

Run with:
    python server.py

The server intentionally avoids FastAPI/Pydantic so it can run from the
installed Python on this machine while reusing the existing PuffcoBLE package.
It serves the repository root web assets over HTTP and exposes a WebSocket
control channel.
"""

from __future__ import annotations

import argparse
import asyncio
import itertools
import json
import math
import mimetypes
import struct
import sys
import threading
import traceback
import webbrowser
from concurrent.futures import TimeoutError as FutureTimeoutError
from datetime import datetime
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any, Optional


TOOLS_DIR = Path(__file__).resolve().parent
ROOT = TOOLS_DIR.parent
WEB_DIR = ROOT
VENDORED_SITE = ROOT / ".venv-puffco" / "Lib" / "site-packages"
sys.path.insert(0, str(TOOLS_DIR))
if VENDORED_SITE.exists():
    sys.path.insert(0, str(VENDORED_SITE))

if sys.platform != "win32":
    raise SystemExit("This controller is Windows-only because it uses Windows Bluetooth LE.")

try:
    from bleak import BleakClient, BleakScanner  # noqa: E402
    from bleak.exc import BleakCharacteristicNotFoundError  # noqa: E402
    from puffcoble import PuffcoBLE  # noqa: E402
    from puffcoble.puffco.constants import LoraxService  # noqa: E402
    from websockets.asyncio.server import serve  # noqa: E402
    from websockets.exceptions import ConnectionClosed  # noqa: E402
except ModuleNotFoundError as exc:
    missing = exc.name or "a required package"
    raise SystemExit(
        f"Missing {missing}. Run start.bat from C:\\PuffcoBLE so the local "
        ".venv-puffco runtime is used, or install requirements-web.txt into "
        "a Windows Python 3.11/3.12 environment."
    ) from exc

from lorax_registry import (  # noqa: E402
    ACTION_COMMANDS,
    PATHS_BY_NAME,
    PATHS_BY_PATH,
    READ_TYPES,
    WRITE_TYPES,
    registry_payload,
    select_paths,
)


SERVER_VERBOSE = False
PROFILE_COUNT = 4
HEAT_STATES = {"HEAT_CYCLE_PREHEAT", "HEAT_CYCLE_ACTIVE", "HEAT_CYCLE_FADE"}
BATTERY_PERCENT_PATHS = ("/p/bat/soc", "/p/bat/lev")
TEMP_MAPPING_FILE = ROOT / "lorax_mappings.json"
OPERATING_STATE_NAMES = {
    0: "InitMemory",
    1: "InitVersion",
    2: "InitBattery",
    3: "MasterOff",
    4: "Sleep",
    5: "Idle",
    6: "TempSelect",
    7: "HeatCyclePreheat",
    8: "HeatCycleActive",
    9: "HeatCycleFade",
    10: "Version",
    11: "BattLevel",
    12: "FactoryTest",
    13: "Bonding",
}
CHARGE_STATE_LABELS = {
    0: "Charging",
    1: "Charging",
    2: "Full",
    3: "Charging paused",
    4: "Done/Disconnected",
}
CHAMBER_TYPE_LABELS = {
    0: "No chamber",
    1: "Classic chamber",
    2: "XL chamber",
    3: "3D chamber",
    4: "Toad chamber",
}
OFFICIAL_LIVE_TEMPERATURE_SOURCE = {
    "path": "/p/app/htr/temp",
    "encoding": "float32_c",
    "evidence": {
        "source": "official_puffco_app_bundle",
        "attribute": "userHeaterTemp",
        "notes": "Official app maps currentTemperature from userHeaterTemp at /p/app/htr/temp as Celsius float32.",
    },
}
OFFICIAL_ATTRIBUTE_SPECS = {
    "approxDabsRemaining": ("/p/app/info/drem", "float32"),
    "batteryLevel": ("/p/bat/soc", "float32"),
    "chargeEstimatedTimeToFull": ("/p/bat/chg/etf", "float32"),
    "chargeState": ("/p/bat/chg/stat", "uint8"),
    "chargeSource": ("/p/bat/chg/src", "uint8"),
    "chargeCurrent": ("/p/bat/chg/iout", "float32"),
    "chargeElapsedTime": ("/p/bat/chg/elap", "float32"),
    "batteryCapacity": ("/p/bat/cap", "float32"),
    "batteryCurrent": ("/p/bat/curr", "float32"),
    "batteryVoltage": ("/p/bat/volt", "float32"),
    "batteryTemperature": ("/p/bat/temp", "float32"),
    "maxBatteryLevel": ("/u/bat/msoc", "float32"),
    "chamberType": ("/p/htr/chmt", "uint8"),
    "cableHandshakeDetected": ("/p/htr/chdt", "uint32"),
    "currentTemperature": ("/p/app/htr/temp", "float32"),
    "targetTemperature": ("/p/app/htr/tcmd", "float32"),
    "heaterTemperature": ("/p/htr/temp", "float32"),
    "heaterTargetTemperature": ("/p/htr/tcmd", "float32"),
    "heaterPower": ("/p/htr/pwr", "float32"),
    "heaterResistance": ("/p/htr/res", "float32"),
    "heaterVoltage": ("/p/htr/vavg", "float32"),
    "dabsPerDay": ("/p/app/info/dpd", "float32"),
    "faultEndIndex": ("/p/logv/flt/end", "uint32"),
    "selectedHeatCycle": ("/p/app/hcs", "int8"),
    "lanternTime": ("/p/app/ltrn/time", "float32"),
    "lanternRemainingTime": ("/p/app/ltrn/remt", "float32"),
    "totalHeatCycles": ("/p/app/odom/0/nc", "float32"),
    "dabTotalTime": ("/p/app/odom/0/tm", "float32"),
    "operatingState": ("/p/app/stat/id", "uint8"),
    "stateElapsedTime": ("/p/app/stat/elap", "float32"),
    "stateTotalTime": ("/p/app/stat/tott", "float32"),
    "boostTemperature": ("/p/app/thc/btmp", "float32"),
    "boostTime": ("/p/app/thc/btim", "float32"),
    "brightness": ("/u/app/ui/lbrt", "bytes"),
    "mode": ("/u/app/rdym/hc", "float32"),
    "dateOfBirth": ("/u/sys/bday", "uint32"),
    "utcTime": ("/p/sys/time", "uint32"),
    "stealth": ("/u/app/ui/stlm", "uint8"),
    "lowBatteryIndicator": ("/u/app/lbws", "float32"),
    "bleFault.absoluteCount": ("/p/app/bt/ufca", "uint32"),
    "bleFault.creditCount": ("/p/app/bt/ufcc", "uint32"),
}
FAST_OFFICIAL_ATTRIBUTES = (
    "batteryLevel",
    "chargeState",
    "currentTemperature",
    "targetTemperature",
    "chamberType",
    "operatingState",
    "stateElapsedTime",
    "stateTotalTime",
    "chargeEstimatedTimeToFull",
    "lanternRemainingTime",
    "stealth",
    "approxDabsRemaining",
    "dabsPerDay",
    "brightness",
    "boostTemperature",
    "boostTime",
    "lanternTime",
    "maxBatteryLevel",
)


def empty_temperature_source() -> dict[str, Any]:
    return {"path": None, "encoding": None, "evidence": None, "persisted": False}


def load_temperature_source() -> dict[str, Any]:
    try:
        payload = json.loads(TEMP_MAPPING_FILE.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return empty_temperature_source()
    source = payload.get("live_temperature") if isinstance(payload, dict) else None
    if not isinstance(source, dict):
        return empty_temperature_source()
    path = source.get("path")
    encoding = source.get("encoding")
    if not path or not encoding or path not in PATHS_BY_PATH:
        return empty_temperature_source()
    return {
        "path": path,
        "encoding": encoding,
        "evidence": source.get("evidence"),
        "persisted": True,
        "updated_at": source.get("updated_at"),
    }


def save_temperature_source(source: dict[str, Any]) -> None:
    if not source.get("path"):
        try:
            TEMP_MAPPING_FILE.unlink()
        except FileNotFoundError:
            pass
        return
    payload = {
        "live_temperature": {
            "path": source.get("path"),
            "encoding": source.get("encoding"),
            "evidence": source.get("evidence"),
            "updated_at": datetime.now().isoformat(timespec="seconds"),
        }
    }
    TEMP_MAPPING_FILE.write_text(json.dumps(payload, indent=2), encoding="utf-8")


def set_live_temperature_source(source: dict[str, Any] | None, *, persist: bool = True) -> dict[str, Any]:
    global live_temperature_source
    live_temperature_source = source.copy() if source and source.get("path") else empty_temperature_source()
    live_temperature_source["persisted"] = bool(live_temperature_source.get("path") and persist)
    if persist:
        save_temperature_source(live_temperature_source)
    return live_temperature_source

device: Optional[PuffcoBLE] = None
device_connected = False
clients: set[Any] = set()
poll_task: Optional[asyncio.Task] = None
command_lock: Optional[asyncio.Lock] = None
connection_lock: Optional[asyncio.Lock] = None
server_loop: Optional[asyncio.AbstractEventLoop] = None
heat_session: dict[str, Any] = {"active": False}
live_temperature_source: dict[str, Any] = load_temperature_source()
temperature_discovery_samples: dict[str, dict[str, Any]] = {}
temperature_discovery_index = 0
snapshot_cache: dict[str, Any] = {}
background_reads_paused_until = 0.0
connection_session_counter = itertools.count(1)
ignored_disconnect_callbacks = 0

if not live_temperature_source.get("path"):
    set_live_temperature_source(OFFICIAL_LIVE_TEMPERATURE_SOURCE, persist=False)


def state_name(value: Any) -> str:
    return str(value.name) if hasattr(value, "name") else str(value)


def log_event(area: str, message: str, *, level: str = "INFO", **fields: Any) -> None:
    timestamp = datetime.now().strftime("%H:%M:%S")
    extras = " ".join(
        f"{key}={json_safe(value)}"
        for key, value in fields.items()
        if value is not None and value != ""
    )
    line = f"{timestamp} {level:<5} {area:<8} {message}"
    if extras:
        line = f"{line} | {extras}"
    print(line, flush=True)


def summarize_ws_payload(payload: Any) -> str:
    if not isinstance(payload, dict):
        return type(payload).__name__
    parts = []
    for key in ("type", "message"):
        if payload.get(key):
            parts.append(f"{key}={payload.get(key)}")
    data = payload.get("data")
    if isinstance(data, dict):
        data_keys = ",".join(list(data.keys())[:10])
        parts.append(f"data_keys={data_keys}")
        if data.get("connected") is not None:
            parts.append(f"connected={data.get('connected')}")
    return " ".join(parts) or ",".join(payload.keys())


def normalized_state_key(value: Any) -> str:
    normalized = state_name(value).upper().replace(" ", "_").replace("-", "_")
    aliases = {
        "INITMEMORY": "INIT_MEMORY",
        "INITVERSION": "INIT_VERSION",
        "INITBATTERY": "INIT_BATTERY",
        "MASTEROFF": "MASTER_OFF",
        "TEMPSELECT": "TEMP_SELECT",
        "HEATCYCLEPREHEAT": "HEAT_CYCLE_PREHEAT",
        "HEATCYCLEACTIVE": "HEAT_CYCLE_ACTIVE",
        "HEATCYCLEFADE": "HEAT_CYCLE_FADE",
        "BATTLEVEL": "BATT_LEVEL",
        "FACTORYTEST": "FACTORY_TEST",
    }
    return aliases.get(normalized, normalized)


def heat_status(value: Any) -> str:
    name = normalized_state_key(value)
    if name in HEAT_STATES:
        return "HEATING"
    if name in {"IDLE", "SLEEP", "MASTER_OFF"}:
        return "idle"
    return "other"


def is_heat_state(value: Any) -> bool:
    return normalized_state_key(value) in HEAT_STATES


REQUIRED_LORAX_CHARS = (
    LoraxService.VERSION_CHAR,
    LoraxService.COMMAND_CHAR,
    LoraxService.REPLY_CHAR,
)


def ble_link_connected() -> bool:
    client = getattr(device, "client", None) if device else None
    return bool(client and getattr(client, "is_connected", False))


def is_ble_connection_error(exc: Exception) -> bool:
    if isinstance(exc, (BleakCharacteristicNotFoundError, ConnectionError, TimeoutError, OSError)):
        return True
    text = f"{type(exc).__name__}: {exc}".lower()
    return any(
        marker in text
        for marker in (
            "characteristic",
            "gatt",
            "not connected",
            "device not found",
            "operation was canceled",
            "winerror",
            "unreachable",
            "disconnected",
        )
    )


def ble_error_hint(exc: Exception) -> str | None:
    text = f"{type(exc).__name__}: {exc}".lower()
    if "unreachable" in text:
        return (
            "The device is unreachable. This usually means it is currently connected to another device "
            "(like the official Puffco app on your phone) or needs to be restarted. Please close the "
            "official app on all phones/tablets, turn the Puffco off and on, and try again."
        )
    if "characteristic" in text or "gatt" in text:
        return (
            "Windows reported an incomplete/stale GATT service table. The app will force a fresh BLE "
            "client on the next attempt; if it repeats, turn the Puffco off/on or toggle Windows Bluetooth."
        )
    if "operation was canceled" in text or "winerror -2147023673" in text:
        return (
            "Windows canceled the BLE connect before Puffco auth. Close the official Puffco app and retry; "
            "if it repeats, toggle Windows Bluetooth."
        )
    if "device not found" in text:
        return "The device was not advertising during the scan. Wake it, keep it nearby, and retry."
    if "timed out" in text or "timeout" in text:
        return "Windows did not finish the BLE handshake in time. Retrying with a clean client usually helps."
    return None


def disconnected_snapshot(reason: str = "Device disconnected") -> dict[str, Any]:
    return {
        "connected": False,
        "disconnect_reason": reason,
        "backend": {
            "transport": "windows_python_ble",
            "device_connected_flag": False,
            "ble_link_connected": False,
            "polling": False,
            "poll_interval_s": 1.0,
            "connection_operation_busy": bool(connection_lock and connection_lock.locked()),
            "command_operation_busy": bool(command_lock and command_lock.locked()),
            "ignored_disconnect_callbacks": ignored_disconnect_callbacks,
            "reason": reason,
        },
        "labels": {"state": "Disconnected", "heat": "Idle"},
        "readable": {"state": "Disconnected", "heat": "Idle", "summary": reason},
        "timestamp": datetime.now().isoformat(timespec="seconds"),
    }


def enforce_connected_snapshot(data: dict[str, Any] | None) -> dict[str, Any]:
    snapshot = dict(data or {})
    snapshot["connected"] = True
    if device:
        if not snapshot.get("name"):
            snapshot["name"] = (
                getattr(device, "resolved_name", None)
                or getattr(device, "device_name", None)
                or "Connected"
            )
        if not snapshot.get("address"):
            snapshot["address"] = getattr(device, "resolved_address", None) or getattr(device, "device_mac", None)
    return snapshot


async def mark_device_disconnected(reason: str = "Device disconnected") -> dict[str, Any]:
    global device, device_connected, snapshot_cache
    device_connected = False
    stop_polling()
    old_device = device
    device = None
    snapshot_cache = {}
    try:
        client = getattr(old_device, "client", None) if old_device else None
        if client and getattr(client, "is_connected", False):
            await old_device.disconnect()
    except Exception:
        pass
    return disconnected_snapshot(reason)


async def broadcast_backend_disconnect(reason: str) -> None:
    snapshot = await mark_device_disconnected(reason)
    await broadcast({"type": "disconnected", "message": reason, "data": snapshot})


def schedule_backend_disconnect(
    reason: str,
    *,
    source: Any | None = None,
    session_id: int | None = None,
) -> None:
    if not server_loop:
        return

    def _schedule() -> None:
        global ignored_disconnect_callbacks
        active_session = getattr(device, "session_id", None) if device else None
        is_current_device = source is None or source is device
        is_current_session = session_id is None or session_id == active_session
        if device_connected and is_current_device and is_current_session:
            asyncio.create_task(broadcast_backend_disconnect(reason))
        else:
            ignored_disconnect_callbacks += 1

    server_loop.call_soon_threadsafe(_schedule)


class WebPuffcoBLE(PuffcoBLE):
    def __init__(
        self,
        *args: Any,
        use_cached_services: bool = False,
        disconnect_reason: str = "Bluetooth link closed",
        **kwargs: Any,
    ):
        super().__init__(*args, **kwargs)
        self.use_cached_services = use_cached_services
        self.disconnect_reason = disconnect_reason
        self.resolved_name: str | None = None
        self.resolved_address: str | None = None
        self.session_id: int | None = None

    async def connect(self) -> BleakClient:
        found = await self.search_for_device()
        if not found:
            raise RuntimeError("Device not found")

        self.resolved_name = found.name
        self.resolved_address = found.address
        self.debug_print(f"Connecting to {found.name} ({found.address})")
        client = BleakClient(
            found,
            disconnected_callback=lambda _client: schedule_backend_disconnect(
                self.disconnect_reason,
                source=self,
                session_id=self.session_id,
            ),
            winrt={"use_cached_services": self.use_cached_services},
            timeout=25.0,
        )
        connected = False
        try:
            connected = await client.connect()
            if not connected:
                raise ConnectionError("Failed to connect to device")
            self.client = client
            await self.ensure_lorax_characteristics()
            await self.trigger_bonding()
            await self.auth_device()
            return client
        except Exception:
            if connected or getattr(client, "is_connected", False):
                try:
                    await client.disconnect()
                except Exception:
                    pass
            if self.client is client:
                self.client = None
            raise

    async def ensure_lorax_characteristics(self) -> None:
        if not self.client:
            raise RuntimeError("Client not connected")
        try:
            services = self.client.services
        except Exception:
            services = None
        missing = []
        for char_uuid in REQUIRED_LORAX_CHARS:
            try:
                characteristic = services.get_characteristic(char_uuid) if services else None
            except Exception:
                characteristic = None
            if characteristic is None:
                missing.append(char_uuid)
        if missing:
            raise BleakCharacteristicNotFoundError(", ".join(missing))


def pause_background_reads(seconds: float = 1.5) -> None:
    global background_reads_paused_until
    try:
        now = asyncio.get_running_loop().time()
    except RuntimeError:
        return
    background_reads_paused_until = max(background_reads_paused_until, now + seconds)


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


def hex_color(value: str) -> str:
    color = value.strip()
    if not color.startswith("#"):
        color = f"#{color}"
    if len(color) != 7:
        raise ValueError("color must look like #RRGGBB")
    int(color[1:], 16)
    return color.lower()


def profile_index(value: Any) -> int:
    index = int(value)
    if not 0 <= index < PROFILE_COUNT:
        raise ValueError(f"profile index must be 0-{PROFILE_COUNT - 1}")
    return index


def temp_f_value(value: Any) -> float:
    temp = float(value)
    if not 250 <= temp <= 700:
        raise ValueError("temperature must be 250-700 F")
    return temp


def profile_seconds_value(value: Any) -> float:
    seconds = float(value)
    if not 5 <= seconds <= 180:
        raise ValueError("duration must be 5-180 seconds")
    return seconds


def percent_value(value: Any) -> int:
    percent = int(value)
    if not 1 <= percent <= 100:
        raise ValueError("brightness must be 1-100%")
    return percent


def percent_to_byte(percent: int) -> int:
    return max(1, min(255, round(percent * 255 / 100)))


def battery_percent(value: Any) -> int | None:
    if value is None:
        return None
    try:
        numeric = float(value)
    except (TypeError, ValueError):
        return None
    if not 0 <= numeric <= 100:
        return None
    return max(0, min(100, round(numeric)))


def battery_percent_candidate(raw: bytes) -> tuple[int | None, str | None]:
    if not raw:
        return None, None
    if len(raw) >= 4:
        float_value = struct.unpack("<f", raw[:4])[0]
        if math.isfinite(float_value) and (0.01 <= float_value <= 100 or float_value == 0):
            percent = battery_percent(float_value)
            if percent is not None:
                return percent, "float32"
        uint_value = struct.unpack("<I", raw[:4])[0]
        percent = battery_percent(uint_value)
        if percent is not None:
            return percent, "uint32"
        if raw[1:4] == b"\x00\x00\x00":
            percent = battery_percent(raw[0])
            if percent is not None:
                return percent, "uint8"
    else:
        percent = battery_percent(raw[0])
        if percent is not None:
            return percent, "uint8"
    return None, None


def humanize_token(value: Any) -> str | None:
    if value is None:
        return None
    text = state_name(value).strip()
    if not text:
        return None
    text = text.split(".")[-1]
    prefixes = ("CHAMBER_TYPE_", "HEAT_CYCLE_", "CHARGE_")
    for prefix in prefixes:
        if text.upper().startswith(prefix):
            text = text[len(prefix) :]
            break
    words = text.replace("-", "_").replace(" ", "_").split("_")
    label_words = []
    for word in words:
        if not word:
            continue
        upper = word.upper()
        label_words.append(upper if upper in {"BLE", "LED", "XL", "3D"} else word.lower().capitalize())
    return " ".join(label_words) or None


def charge_label(value: Any) -> str | None:
    if isinstance(value, (int, float)) and float(value).is_integer():
        label = CHARGE_STATE_LABELS.get(int(value))
        if label:
            return label
    normalized = state_name(value).upper() if value is not None else ""
    labels = {
        "NOT_CHARGING": "Not charging",
        "CHARGING": "Charging",
        "BULK": "Charging",
        "TOPUP": "Charging",
        "FULLY_CHARGED": "Full",
        "FULL": "Full",
        "COMPLETE": "Full",
        "CHARGE_COMPLETE": "Full",
        "DISCHARGING": "On battery",
        "DONE_DISCONNECTED": "Done/Disconnected",
        "TEMP_STOP": "Charging paused",
    }
    return labels.get(normalized) or humanize_token(value)


def chamber_label(value: Any) -> str | None:
    if isinstance(value, (int, float)) and float(value).is_integer():
        label = CHAMBER_TYPE_LABELS.get(int(value))
        if label:
            return label
    normalized = state_name(value).upper() if value is not None else ""
    if "XL" in normalized and "3D" in normalized:
        return "3D XL chamber"
    if "XL" in normalized:
        return "XL chamber"
    if "3D" in normalized:
        return "3D chamber"
    label = humanize_token(value)
    return f"{label} chamber" if label else None


def state_label(value: Any) -> str | None:
    normalized = normalized_state_key(value) if value is not None else ""
    labels = {
        "IDLE": "Idle",
        "HEAT_CYCLE_PREHEAT": "Preheating",
        "HEAT_CYCLE_ACTIVE": "Heating",
        "HEAT_CYCLE_FADE": "Cooling down",
        "SLEEP": "Sleep",
        "MASTER_OFF": "Off",
        "CHARGING": "Charging",
    }
    return labels.get(normalized) or humanize_token(value)


def heat_label(state: Any, heat: Any = None) -> str | None:
    normalized_state = normalized_state_key(state) if state is not None else ""
    if normalized_state in HEAT_STATES:
        return state_label(state)
    normalized_heat = normalized_state_key(heat) if heat is not None else ""
    if normalized_heat == "HEATING":
        return "Heating"
    if normalized_heat in {"IDLE", "OTHER"} or normalized_state in {"IDLE", "SLEEP", "MASTER_OFF"}:
        return "Idle"
    return humanize_token(heat) or state_label(state)


def metric_label(value: Any, fraction_digits: int = 0) -> str | None:
    if value is None:
        return None
    try:
        numeric = float(value)
    except (TypeError, ValueError):
        return humanize_token(value) or str(value)
    if not (-1_000_000_000 <= numeric <= 1_000_000_000):
        return None
    label = f"{numeric:,.{fraction_digits}f}"
    if "." in label:
        label = label.rstrip("0").rstrip(".")
    return "0" if label in {"", "-"} else label


def dabs_per_day_label(value: Any) -> str | None:
    if value is None:
        return None
    try:
        numeric = float(value)
    except (TypeError, ValueError):
        return humanize_token(value) or str(value)
    if not (-1_000_000_000 <= numeric <= 1_000_000_000):
        return None
    if abs(numeric) < 10:
        return metric_label(numeric, 2)
    return metric_label(numeric, 1)


def temperature_label(value: Any) -> str | None:
    label = metric_label(value, 0)
    return f"{label} F" if label is not None else None


def percent_label(value: Any) -> str | None:
    label = metric_label(value, 0)
    return f"{label}%" if label is not None else None


def seconds_label(value: Any) -> str | None:
    if value is None:
        return None
    try:
        seconds = max(0, round(float(value)))
    except (TypeError, ValueError):
        return humanize_token(value) or str(value)
    minutes, remaining = divmod(seconds, 60)
    if minutes and remaining:
        return f"{minutes}m {remaining:02d}s"
    if minutes:
        return f"{minutes}m"
    return f"{remaining}s"


def bool_label(value: Any) -> str | None:
    if value is None:
        return None
    if isinstance(value, bool):
        return "On" if value else "Off"
    try:
        numeric = float(value)
    except (TypeError, ValueError):
        text = str(value).strip().lower()
        if text in {"true", "on", "yes", "1"}:
            return "On"
        if text in {"false", "off", "no", "0"}:
            return "Off"
        return humanize_token(value) or str(value)
    return "On" if numeric != 0 else "Off"


def temperature_delta_label_c(value: Any) -> str | None:
    if value is None:
        return None
    try:
        fahrenheit_delta = float(value) * 9 / 5
    except (TypeError, ValueError):
        return humanize_token(value) or str(value)
    sign = "+" if fahrenheit_delta > 0 else ""
    return f"{sign}{metric_label(fahrenheit_delta, 0)} F"


def brightness_label(value: Any) -> str | None:
    if value is None:
        return None
    if isinstance(value, dict):
        parts = []
        for key, raw_value in value.items():
            metric = metric_label(raw_value, 0)
            if metric is not None:
                parts.append(f"{humanize_token(key) or key}: {metric}/255")
        return ", ".join(parts) or None
    metric = metric_label(value, 0)
    if metric is None:
        return humanize_token(value) or str(value)
    try:
        percent = round(max(0, min(255, float(value))) / 255 * 100)
    except (TypeError, ValueError):
        return f"{metric}/255"
    return f"{metric}/255 ({percent}%)"


def seconds_value(value: Any) -> int | None:
    if value is None:
        return None
    try:
        seconds = int(round(float(value)))
    except (TypeError, ValueError):
        return None
    return seconds if seconds >= 0 else None


def valid_heat_target_f(value: Any) -> float | None:
    if value is None:
        return None
    try:
        target = float(value)
    except (TypeError, ValueError):
        return None
    return target if target >= 200 else None


def display_value(value: Any) -> str:
    if value is None or value == "":
        return "Unknown"
    return str(value)


def snapshot_labels(data: dict[str, Any]) -> dict[str, str | None]:
    return {
        "battery": percent_label(data.get("battery")),
        "charge": charge_label(data.get("charge")),
        "chamber": chamber_label(data.get("chamber")),
        "state": state_label(data.get("state")),
        "heat": heat_label(data.get("state"), data.get("heat")),
        "dabs_per_day": dabs_per_day_label(data.get("dabs_per_day")),
        "dabs_left": metric_label(data.get("dabs_left"), 0),
        "total_dabs": metric_label(data.get("total_dabs"), 0),
    }


def snapshot_readable(data: dict[str, Any]) -> dict[str, Any]:
    labels = data.get("labels") or snapshot_labels(data)
    battery = display_value(labels.get("battery"))
    charge = display_value(labels.get("charge"))
    heat = display_value(labels.get("heat"))
    chamber = display_value(labels.get("chamber"))
    dabs_left = display_value(labels.get("dabs_left"))
    dabs_per_day = display_value(labels.get("dabs_per_day"))
    total_dabs = display_value(labels.get("total_dabs"))
    return {
        "device": display_value(data.get("name")),
        "battery": battery,
        "battery_source": display_value(data.get("battery_source")),
        "charging": charge,
        "chamber": chamber,
        "state": display_value(labels.get("state")),
        "heat": heat,
        "usage": {
            "dabs_remaining": dabs_left,
            "dabs_per_day": dabs_per_day,
            "total_dabs": total_dabs,
        },
        "summary": (
            f"{display_value(data.get('name'))}: {battery} battery, "
            f"{charge}, {heat}, {dabs_left} dabs remaining"
        ),
    }


def profile_name_bytes(value: str) -> bytes:
    encoded = value.encode("utf-8")
    if len(encoded) > 31:
        raise ValueError("profile name too long (max 31 UTF-8 bytes)")
    return encoded + b"\x00" * (32 - len(encoded))


MOOD_PRESETS: dict[str, dict[str, Any]] = {
    "no_animation": {
        "name": "Static color",
        "desc": "Split your Peak into different color regions",
        "tag": "pikaled2-no-animation-mood-light",
        "min_colors": 1,
        "max_colors": 6,
        "defaults": ["#ff0000"],
        "anim": 1,
    },
    "fade": {
        "name": "Fade",
        "desc": "Smooth transitions",
        "tag": "pikaled2-fade-mood-light",
        "min_colors": 2,
        "max_colors": 6,
        "defaults": ["#ff0000", "#00ff00"],
        "anim": 1,
    },
    "disco": {
        "name": "Disco",
        "desc": "A spiraling color cycle",
        "tag": "pikaled2-disco-mood-light",
        "min_colors": 2,
        "max_colors": 6,
        "defaults": ["#ff0000", "#00ff00", "#0000ff"],
        "anim": 1,
    },
    "spin": {
        "name": "Spin",
        "desc": "A lighthouse to guide you",
        "tag": "pikaled2-spin-mood-light",
        "min_colors": 1,
        "max_colors": 6,
        "defaults": ["#ff0000"],
        "anim": 7,
    },
    "split_gradient": {
        "name": "Split Gradient",
        "desc": "Look into the fissure",
        "tag": "pikaled2-split-gradient-mood-light",
        "min_colors": 2,
        "max_colors": 6,
        "defaults": ["#ff0000", "#00ff00"],
        "anim": 1,
    },
    "vertical_slideshow": {
        "name": "Vertical Slideshow",
        "desc": "Colors slide upwards",
        "tag": "pikaled2-vertical-slideshow-mood-light",
        "min_colors": 2,
        "max_colors": 6,
        "defaults": ["#ff0000", "#00ff00"],
        "anim": 1,
    },
}

NO_ANIMATION_OFFSETS = [
    [0, 0, 0, 0, 0, 0, 65536, 0, 0, 65536, 0, 0, 65536, 65536, 0, 0, 65536, 65536, 65536, 0],
    [0, 0, 0, 0, 0, 0, 65536, 0, 0, 65536, 4096, 4096, 65536, 65536, 4096, 4096, 65536, 65536, 65536, 4096],
    [0, 0, 0, 0, 0, 0, 65536, 8192, 8192, 65536, 4096, 4096, 65536, 65536, 4096, 4096, 65536, 65536, 65536, 4096],
    [0, 0, 0, 0, 0, 0, 65536, 8192, 12288, 65536, 4096, 4096, 65536, 65536, 4096, 4096, 65536, 65536, 65536, 4096],
    [0, 0, 16384, 16384, 16384, 0, 65536, 8192, 12288, 65536, 4096, 4096, 65536, 65536, 4096, 4096, 65536, 65536, 65536, 4096],
    [0, 0, 16384, 16384, 16384, 0, 65536, 8192, 12288, 65536, 4096, 4096, 65536, 65536, 20480, 20480, 65536, 65536, 65536, 4096],
]

DISCO_BASE_OFFSETS = [
    15360, 18773, 1707, 5120, 8533, 11947, 15360, 10240, 10240, 5120,
    2844, 1138, 853, 19627, 19342, 17636, 0, 0, 0, 0,
]
SPLIT_OFFSETS_2 = [0, 0, 0, 0, 0, 0, 7680, 25600, 15360, 7680, 12800, 12800, 17920, 17920, 12800, 12800, 15360, 15360, 15360, 15360]
SPLIT_OFFSETS_3_4 = [0, 0, 0, 0, 0, 0, 7680, 46080, 15360, 7680, 33280, 33280, 38400, 38400, 33280, 33280, 15360, 15360, 15360, 15360]
SPLIT_OFFSETS_5_6 = [0, 0, 0, 0, 0, 0, 7680, 66560, 15360, 7680, 53760, 53760, 58880, 58880, 53760, 53760, 15360, 15360, 15360, 15360]
VERTICAL_SLIDESHOW_OFFSETS = [20480, 20480, 20480, 20480, 20480, 20480, 15930, 9100, 11835, 15930, 0, 0, 6825, 6825, 0, 0, 20480, 20480, 20480, 20480]


def clamp_float(value: Any, low: float, high: float, default: float) -> float:
    try:
        numeric = float(value)
    except (TypeError, ValueError):
        return default
    if not math.isfinite(numeric):
        return default
    return max(low, min(high, numeric))


def normalize_color_list(value: Any, preset: dict[str, Any]) -> list[str]:
    if value is None:
        raw_colors = preset["defaults"]
    elif isinstance(value, str):
        raw_colors = [part.strip() for part in value.split(",") if part.strip()]
    elif isinstance(value, (list, tuple)):
        raw_colors = [str(part).strip() for part in value if str(part).strip()]
    else:
        raise ValueError("colors must be a list or comma-separated string")

    colors = [hex_color(color) for color in raw_colors]
    min_colors = int(preset["min_colors"])
    max_colors = int(preset["max_colors"])
    if len(colors) < min_colors:
        raise ValueError(f"{preset['name']} needs at least {min_colors} color(s)")
    if len(colors) > max_colors:
        raise ValueError(f"{preset['name']} supports at most {max_colors} colors")
    return colors


def hex_to_rgb(color: str) -> tuple[int, int, int]:
    color = hex_color(color)
    return int(color[1:3], 16), int(color[3:5], 16), int(color[5:7], 16)


def rgb_to_hex(rgb: tuple[int, int, int]) -> str:
    return "#{:02x}{:02x}{:02x}".format(*(max(0, min(255, int(round(channel)))) for channel in rgb))


def color_table(colors: list[str], length: int, *, steady: float = 0.0) -> list[str]:
    if length <= 0:
        return []
    if len(colors) == 1:
        return [colors[0]] * length
    rgbs = [hex_to_rgb(color) for color in colors]
    out = []
    for idx in range(length):
        pos = idx / length * len(rgbs)
        base = int(math.floor(pos)) % len(rgbs)
        frac = pos - math.floor(pos)
        if steady:
            hold = max(0.0, min(0.9, steady)) / 2
            if frac < hold:
                frac = 0.0
            elif frac > 1 - hold:
                frac = 1.0
            else:
                frac = (frac - hold) / (1 - 2 * hold)
        eased = 0.5 - math.cos(frac * math.pi) / 2
        nxt = (base + 1) % len(rgbs)
        rgb = tuple(rgbs[base][channel] + (rgbs[nxt][channel] - rgbs[base][channel]) * eased for channel in range(3))
        out.append(rgb_to_hex(rgb))
    return out


def mood_speed(preset_id: str, tempo_frac: float) -> int:
    tempo_cpm = tempo_frac * tempo_frac * 480
    if preset_id == "spin":
        return max(0, min(255, round(tempo_cpm * 256 / 480)))
    if preset_id in {"split_gradient", "vertical_slideshow"} and tempo_cpm <= 0:
        return 64
    return max(0, min(255, round(tempo_cpm / 3)))


def mood_offsets(preset_id: str, color_count: int) -> list[int]:
    if preset_id == "no_animation":
        return NO_ANIMATION_OFFSETS[color_count - 1]
    if preset_id == "disco":
        return [round(value * color_count) for value in DISCO_BASE_OFFSETS]
    if preset_id == "split_gradient":
        if color_count == 2:
            return SPLIT_OFFSETS_2
        if color_count <= 4:
            return SPLIT_OFFSETS_3_4
        return SPLIT_OFFSETS_5_6
    if preset_id == "vertical_slideshow":
        return VERTICAL_SLIDESHOW_OFFSETS
    return [0] * 20


def mood_light_payload(
    preset_id: str,
    colors: Any = None,
    *,
    tempo_frac: Any = 0.5,
    dynamic_inhale: Any = False,
) -> dict[str, Any]:
    preset_key = str(preset_id or "no_animation").strip().lower().replace("-", "_")
    preset = MOOD_PRESETS.get(preset_key)
    if not preset:
        raise ValueError(f"unknown mood preset: {preset_id}")

    user_colors = normalize_color_list(colors, preset)
    tempo = clamp_float(tempo_frac, 0, 1, 0.5)
    dynamic = 1 if bool(dynamic_inhale) else 0
    count = len(user_colors)
    speed = mood_speed(preset_key, tempo)
    speed_di1 = min(speed * 2, 255)
    speed_di0 = speed_di1 / 8

    if preset_key == "no_animation":
        table = user_colors
        color_len = 32
        pl_num = 0
        pl_denom = 1
        params: dict[str, Any] = {
            "bright": 255,
            "speed": 64,
            "anim": 1,
            "plNum": pl_num,
            "plDenom": pl_denom,
            "offset": mood_offsets(preset_key, count),
            "color": table,
            "colorLen": color_len,
        }
    else:
        color_len = count * 5
        table = color_table(user_colors, color_len, steady=0.3 if preset_key in {"fade", "spin"} else 0.0)
        tempo_cpm = tempo * tempo * 480
        pl_num = 1 if preset_key == "spin" else 0
        if preset_key == "spin":
            pl_denom = count
        elif preset_key in {"disco", "split_gradient", "vertical_slideshow"}:
            pl_denom = 0 if tempo_cpm > 0 else 1
        else:
            pl_denom = 0
        params = {
            "bright": 255,
            "speed": speed,
            "speedDi0": speed_di0,
            "speedDi1": speed_di1,
            "anim": int(preset["anim"]),
            "plNum": pl_num,
            "plDenom": pl_denom,
            "offset": mood_offsets(preset_key, count),
            "color": table,
            "colorLen": color_len,
            "diFrac": dynamic,
        }

    return {
        "lamp": {
            "name": "pikaled2",
            "param": params,
        },
        "meta": {
            "led3Name": preset["name"],
            "led3Tag": preset["tag"],
            "moodName": preset["name"],
            "moodType": preset_key,
            "desc": preset["desc"],
            "userColors": user_colors,
            "arrayColors": table,
            "tempoFrac": tempo,
            "dynamicInhale": dynamic,
            "format": "official-pikaled2-profile-colr",
            "version": int(preset.get("version", 1)),
        },
    }


def profile_colour_payload(hex_str: str) -> dict[str, Any]:
    color = hex_color(hex_str)
    return mood_light_payload("no_animation", [color], tempo_frac=0.5, dynamic_inhale=False)


async def safe(call) -> Any:
    try:
        return await call()
    except Exception:
        return None


def mood_payload_summary(payload: Any) -> dict[str, Any]:
    if not isinstance(payload, dict):
        return {
            "official_compatible": False,
            "reason": "profile color payload is not a decoded object",
        }

    lamp = payload.get("lamp") if isinstance(payload.get("lamp"), dict) else {}
    param = lamp.get("param") if isinstance(lamp.get("param"), dict) else {}
    meta = payload.get("meta") if isinstance(payload.get("meta"), dict) else {}
    mood_type = str(meta.get("moodType") or "").strip().lower().replace("-", "_")

    colors = meta.get("userColors")
    if not isinstance(colors, list):
        colors = []
    normalized_colors: list[str] = []
    for color in colors:
        try:
            normalized_colors.append(hex_color(str(color)))
        except (TypeError, ValueError):
            pass

    color_table_value = param.get("color")
    color_table_count = len(color_table_value) if isinstance(color_table_value, list) else None
    return {
        "official_compatible": (
            lamp.get("name") == "pikaled2"
            and mood_type in MOOD_PRESETS
            and bool(normalized_colors)
        ),
        "lamp": lamp.get("name"),
        "mood_type": mood_type or None,
        "mood_name": meta.get("moodName") or meta.get("led3Name"),
        "led3_tag": meta.get("led3Tag"),
        "user_colors": normalized_colors,
        "tempo_frac": clamp_float(meta.get("tempoFrac"), 0, 1, 0.5),
        "dynamic_inhale": bool(meta.get("dynamicInhale")),
        "color_len": param.get("colorLen"),
        "color_table_count": color_table_count,
        "format": meta.get("format"),
    }


def mood_payload_matches(expected: dict[str, Any], actual: dict[str, Any]) -> tuple[bool, list[str]]:
    mismatches: list[str] = []
    if not actual.get("official_compatible"):
        mismatches.append("readback is not an official pikaled2 mood payload")
    if expected.get("mood_type") != actual.get("mood_type"):
        mismatches.append(f"mood type {actual.get('mood_type')} != {expected.get('mood_type')}")
    if expected.get("user_colors") != actual.get("user_colors"):
        mismatches.append(f"colors {actual.get('user_colors')} != {expected.get('user_colors')}")
    if abs(float(expected.get("tempo_frac", 0.5)) - float(actual.get("tempo_frac", 0.5))) > 0.02:
        mismatches.append(f"tempo {actual.get('tempo_frac')} != {expected.get('tempo_frac')}")
    if bool(expected.get("dynamic_inhale")) != bool(actual.get("dynamic_inhale")):
        mismatches.append(f"dynamic inhale {actual.get('dynamic_inhale')} != {expected.get('dynamic_inhale')}")
    return not mismatches, mismatches


def profile_from_snapshot(snapshot: dict[str, Any], index: int) -> dict[str, Any] | None:
    for profile in snapshot.get("profiles") or []:
        if profile.get("index") == index:
            return profile
    return None


def verify_profile_write(
    snapshot: dict[str, Any],
    index: int,
    requested: dict[str, Any],
    expected_mood_payload: dict[str, Any] | None,
) -> dict[str, Any]:
    profile = profile_from_snapshot(snapshot, index)
    verification: dict[str, Any] = {
        "target": f"profile {index}",
        "ok": False,
        "checks": {},
        "mismatches": [],
    }
    if not profile:
        verification["mismatches"].append("profile was not present in the post-write snapshot")
        return verification

    checks = verification["checks"]
    if requested.get("name") is not None:
        expected_name = str(requested["name"])
        checks["name"] = profile.get("name") == expected_name
        if not checks["name"]:
            verification["mismatches"].append(f"name {profile.get('name')!r} != {expected_name!r}")
    if requested.get("temp_f") is not None:
        expected_temp = temp_f_value(requested["temp_f"])
        actual_temp = profile.get("temp_f")
        checks["temperature"] = actual_temp is not None and abs(float(actual_temp) - expected_temp) <= 1.0
        if not checks["temperature"]:
            verification["mismatches"].append(f"temperature {actual_temp}F != {round(expected_temp)}F")
    if requested.get("time_s") is not None:
        expected_time = profile_seconds_value(requested["time_s"])
        actual_time = profile.get("time_s")
        checks["duration"] = actual_time is not None and abs(float(actual_time) - expected_time) <= 1.0
        if not checks["duration"]:
            verification["mismatches"].append(f"duration {actual_time}s != {round(expected_time)}s")
    if expected_mood_payload is not None:
        expected_mood = mood_payload_summary(expected_mood_payload)
        actual_mood = mood_payload_summary(profile.get("color"))
        mood_ok, mismatches = mood_payload_matches(expected_mood, actual_mood)
        checks["official_mood_light"] = mood_ok
        verification["expected_mood"] = expected_mood
        verification["actual_mood"] = actual_mood
        verification["mismatches"].extend(mismatches)

    verification["ok"] = all(checks.values()) if checks else True
    return verification


async def read_float(path: str) -> float | None:
    if not device:
        return None
    data = await device.read_short(path, 0, 12)
    if not data or len(data) < 4:
        return None
    return round(struct.unpack("<f", bytes(data[:4]))[0], 2)


def read_size_for_type(data_type: str) -> int:
    if data_type in {"uint8", "int8", "bool"}:
        return 1
    if data_type in {"uint16", "int16"}:
        return 2
    if data_type == "bytes":
        return 4
    return 4


def resolve_lorax_path(identifier: str):
    entry = PATHS_BY_PATH.get(identifier) or PATHS_BY_NAME.get(identifier)
    if not entry:
        raise ValueError(f"Unknown Lorax path or registry name: {identifier}")
    return entry


def decode_lorax_bytes(raw: bytes, data_type: str) -> Any:
    if data_type == "bytes":
        return raw.hex(" ")
    if data_type == "text":
        return raw.decode(errors="ignore").rstrip("\x00")
    if data_type not in READ_TYPES:
        raise ValueError(f"Unsupported read type: {data_type}")
    formats = {
        "float32": "f",
        "int16": "h",
        "uint16": "H",
        "int32": "i",
        "uint32": "I",
        "uint8": "B",
        "int8": "b",
        "bool": "?",
    }
    fmt_code = formats[data_type]
    needed = struct.calcsize(f"<{fmt_code}")
    if len(raw) < needed:
        return None
    value = struct.unpack(f"<{fmt_code}", raw[:needed])[0]
    if isinstance(value, float):
        return round(value, 3)
    return value


def version_bytes_label(raw: bytes | bytearray | None) -> str | None:
    if not raw:
        return None
    parts = list(bytes(raw)[:4])
    while len(parts) > 2 and parts[-1] == 0:
        parts.pop()
    return ".".join(str(part) for part in parts) if parts else None


async def read_version_label(path: str) -> str | None:
    if not device:
        return None
    try:
        raw = bytes(await device.read_short(path, 0, 4))
    except Exception:
        return None
    return version_bytes_label(raw)


async def read_text_label(path: str, size: int = 64) -> str | None:
    if not device:
        return None
    try:
        raw = bytes(await device.read_short(path, 0, size))
    except Exception:
        return None
    value = decode_lorax_bytes(raw, "text")
    return str(value).strip() or None


def nested_assign(target: dict[str, Any], key: str, value: Any) -> None:
    if "." not in key:
        target[key] = value
        return
    head, tail = key.split(".", 1)
    nested = target.setdefault(head, {})
    if isinstance(nested, dict):
        nested[tail] = value


def normalize_official_attribute(name: str, value: Any, raw: bytes) -> Any:
    if value is None:
        return None
    if isinstance(value, float) and not math.isfinite(value):
        return None
    if name == "batteryLevel":
        return battery_percent(value)
    if name == "chargeEstimatedTimeToFull":
        try:
            numeric = float(value)
        except (TypeError, ValueError):
            return value
        return numeric if numeric >= 0 else None
    if name in {"currentTemperature", "targetTemperature", "heaterTemperature", "heaterTargetTemperature"}:
        try:
            return round(float(value), 3)
        except (TypeError, ValueError):
            return value
    if name == "operatingState":
        try:
            return OPERATING_STATE_NAMES.get(int(value), value)
        except (TypeError, ValueError):
            return value
    if name == "brightness":
        if len(raw) >= 4:
            channels = {
                "base": raw[0],
                "front": raw[1],
                "glass": raw[2],
                "logo": raw[3],
            }
            return raw[0] if len(set(channels.values())) == 1 else channels
        return raw[0] if raw else None
    if name == "lowBatteryIndicator":
        try:
            numeric = float(value)
        except (TypeError, ValueError):
            return value
        if numeric in {0.0, 1.0, 10.0}:
            return numeric != 0.0
        return numeric
    return value


def official_attribute_readable(attributes: dict[str, Any]) -> dict[str, Any]:
    current_c = attributes.get("currentTemperature")
    target_c = attributes.get("targetTemperature")
    elapsed = seconds_value(attributes.get("stateElapsedTime"))
    total = seconds_value(attributes.get("stateTotalTime"))
    remaining = None
    if elapsed is not None and total is not None:
        remaining = max(0, total - elapsed)
    current_f = fahrenheit_from_celsius(float(current_c)) if isinstance(current_c, (int, float)) else None
    target_f = (
        fahrenheit_from_celsius(float(target_c))
        if isinstance(target_c, (int, float)) and float(target_c) >= 80
        else None
    )
    return {
        "battery": percent_label(attributes.get("batteryLevel")),
        "charge": charge_label(attributes.get("chargeState")),
        "currentTemperature": temperature_label(current_f),
        "targetTemperature": temperature_label(target_f),
        "currentTemperatureF": round(current_f, 1) if current_f is not None else None,
        "targetTemperatureF": round(target_f, 1) if target_f is not None else None,
        "operatingState": state_label(attributes.get("operatingState")),
        "stateElapsed": seconds_label(elapsed),
        "stateTotal": seconds_label(total),
        "countdownRemaining": seconds_label(remaining),
        "countdownRemainingSeconds": remaining,
        "dabsRemaining": metric_label(attributes.get("approxDabsRemaining"), 0),
        "dabsPerDay": dabs_per_day_label(attributes.get("dabsPerDay")),
        "totalHeatCycles": metric_label(attributes.get("totalHeatCycles"), 0),
        "dabTotalTime": seconds_label(attributes.get("dabTotalTime")),
        "boostTemperature": temperature_delta_label_c(attributes.get("boostTemperature")),
        "boostTime": seconds_label(attributes.get("boostTime")),
        "chargeEstimatedTimeToFull": seconds_label(attributes.get("chargeEstimatedTimeToFull")),
        "lanternTime": seconds_label(attributes.get("lanternTime")),
        "lanternRemainingTime": seconds_label(attributes.get("lanternRemainingTime")),
        "selectedHeatCycle": (
            f"Profile {int(attributes['selectedHeatCycle'])}"
            if isinstance(attributes.get("selectedHeatCycle"), (int, float))
            else humanize_token(attributes.get("selectedHeatCycle"))
        ),
        "lowBatteryIndicator": bool_label(attributes.get("lowBatteryIndicator")),
        "maxBatteryLevel": percent_label(attributes.get("maxBatteryLevel")),
        "brightness": brightness_label(attributes.get("brightness")),
    }


async def read_official_attributes(names: tuple[str, ...] | list[str] | None = None) -> dict[str, Any]:
    if not device:
        return {"attributes": {}, "sources": {}, "readable": {}, "errors": {"device": "not connected"}}
    selected = tuple(names or OFFICIAL_ATTRIBUTE_SPECS.keys())
    attributes: dict[str, Any] = {}
    sources: dict[str, Any] = {}
    errors: dict[str, str] = {}
    for name in selected:
        spec = OFFICIAL_ATTRIBUTE_SPECS.get(name)
        if not spec:
            errors[name] = "unknown official attribute"
            continue
        path, data_type = spec
        try:
            raw = bytes(await device.read_short(path, 0, read_size_for_type(data_type)))
            value = decode_lorax_bytes(raw, data_type)
            normalized = normalize_official_attribute(name, value, raw)
            nested_assign(attributes, name, normalized)
            sources[name] = {
                "path": path,
                "type": data_type,
                "raw": raw.hex(" "),
                "value": normalized,
                "interpretations": lorax_interpretations(raw),
            }
        except Exception as exc:
            errors[name] = f"{type(exc).__name__}: {exc}"
    return {
        "attributes": attributes,
        "sources": sources,
        "readable": official_attribute_readable(attributes),
        "errors": errors,
    }


def lorax_interpretations(raw: bytes) -> dict[str, Any]:
    values: dict[str, Any] = {"raw_hex": raw.hex(" "), "length": len(raw)}
    if len(raw) >= 1:
        values["uint8"] = raw[0]
        values["int8"] = struct.unpack("<b", raw[:1])[0]
        values["bool"] = bool(raw[0])
    if len(raw) >= 4:
        values["uint32"] = struct.unpack("<I", raw[:4])[0]
        values["int32"] = struct.unpack("<i", raw[:4])[0]
        values["float32"] = round(struct.unpack("<f", raw[:4])[0], 3)
    text = raw.rstrip(b"\x00")
    if text and all(32 <= byte < 127 for byte in text):
        values["text"] = text.decode("ascii")
    temp_candidates = temperature_interpretations(raw)
    if temp_candidates:
        values["temperature_candidates"] = temp_candidates
    return values


def fahrenheit_from_celsius(value: float) -> float:
    return (value * 1.8) + 32


def temperature_record(encoding: str, value_f: float, raw_value: Any, unit: str) -> dict[str, Any] | None:
    if not math.isfinite(float(value_f)) or not -40 <= float(value_f) <= 850:
        return None
    return {
        "encoding": encoding,
        "value_f": round(float(value_f), 1),
        "value_c": round((float(value_f) - 32) / 1.8, 1),
        "raw_value": round(float(raw_value), 3) if isinstance(raw_value, float) else raw_value,
        "unit": unit,
    }


def temperature_interpretations(raw: bytes) -> list[dict[str, Any]]:
    if not raw:
        return []
    candidates: list[dict[str, Any]] = []

    def add(record: dict[str, Any] | None) -> None:
        if record and all(existing["encoding"] != record["encoding"] for existing in candidates):
            candidates.append(record)

    if len(raw) >= 4:
        f32 = struct.unpack("<f", raw[:4])[0]
        if math.isfinite(f32):
            if -40 <= f32 <= 454:
                add(temperature_record("float32_c", fahrenheit_from_celsius(f32), f32, "C"))
            if -40 <= f32 <= 850:
                add(temperature_record("float32_f", f32, f32, "F"))
        u32 = struct.unpack("<I", raw[:4])[0]
        i32 = struct.unpack("<i", raw[:4])[0]
        for label, value in (("uint32", u32), ("int32", i32)):
            if -40 <= value <= 454:
                add(temperature_record(f"{label}_c", fahrenheit_from_celsius(value), value, "C"))
            if -40 <= value <= 850:
                add(temperature_record(f"{label}_f", value, value, "F"))
            scaled = value / 10
            if -40 <= scaled <= 454:
                add(temperature_record(f"{label}_deci_c", fahrenheit_from_celsius(scaled), scaled, "C x10"))
            if -40 <= scaled <= 850:
                add(temperature_record(f"{label}_deci_f", scaled, scaled, "F x10"))

    if len(raw) >= 2:
        u16 = struct.unpack("<H", raw[:2])[0]
        i16 = struct.unpack("<h", raw[:2])[0]
        for label, value in (("uint16", u16), ("int16", i16)):
            if -40 <= value <= 454:
                add(temperature_record(f"{label}_c", fahrenheit_from_celsius(value), value, "C"))
            if -40 <= value <= 850:
                add(temperature_record(f"{label}_f", value, value, "F"))
            scaled = value / 10
            if -40 <= scaled <= 454:
                add(temperature_record(f"{label}_deci_c", fahrenheit_from_celsius(scaled), scaled, "C x10"))
            if -40 <= scaled <= 850:
                add(temperature_record(f"{label}_deci_f", scaled, scaled, "F x10"))

    if len(raw) == 1 and raw[0] <= 250:
        add(temperature_record("uint8_f", raw[0], raw[0], "F"))
        if raw[0] <= 120:
            add(temperature_record("uint8_c", fahrenheit_from_celsius(raw[0]), raw[0], "C"))
    return candidates


def temperature_value_from_raw(raw: bytes, encoding: str) -> dict[str, Any] | None:
    for candidate in temperature_interpretations(raw):
        if candidate["encoding"] == encoding:
            return candidate
    return None


def summarize_temperature_samples(samples: list[dict[str, Any]]) -> dict[str, Any] | None:
    by_encoding: dict[str, list[dict[str, Any]]] = {}
    for sample in samples:
        if not sample.get("ok"):
            continue
        raw_hex = sample.get("interpretations", {}).get("raw_hex", "")
        raw = bytes.fromhex(raw_hex) if raw_hex else b""
        for candidate in temperature_interpretations(raw):
            by_encoding.setdefault(candidate["encoding"], []).append(
                {**candidate, "index": sample.get("index"), "raw_hex": raw_hex}
            )
    best: dict[str, Any] | None = None
    for encoding, values in by_encoding.items():
        if len(values) < 2:
            continue
        temps = [float(item["value_f"]) for item in values]
        temp_range = max(temps) - min(temps)
        changed = temp_range >= 1.0
        realistic_idle_or_heat = all(40 <= temp <= 700 for temp in temps)
        if not realistic_idle_or_heat:
            continue
        score = len(values)
        if changed:
            score += 4
        if temp_range >= 10:
            score += 2
        if encoding.startswith("float32"):
            score += 1
        if encoding.endswith("_c"):
            score += 1
        trend = "rising" if temps[-1] > temps[0] + 1 else "falling" if temps[-1] < temps[0] - 1 else "steady"
        summary = {
            "encoding": encoding,
            "score": score,
            "samples": len(values),
            "changed": changed,
            "trend": trend,
            "first_f": round(temps[0], 1),
            "last_f": round(temps[-1], 1),
            "min_f": round(min(temps), 1),
            "max_f": round(max(temps), 1),
            "range_f": round(temp_range, 1),
            "last": values[-1],
        }
        if best is None or summary["score"] > best["score"]:
            best = summary
    return best


async def read_battery_status() -> dict[str, Any]:
    candidates: list[dict[str, Any]] = []
    chosen: dict[str, Any] = {
        "percent": None,
        "source": None,
        "source_type": None,
        "raw": None,
        "candidates": candidates,
    }
    if not device:
        return chosen

    for path in BATTERY_PERCENT_PATHS:
        raw = await safe(lambda p=path: device.read_short(p, 0, 4))
        if raw is None:
            candidates.append({"path": path, "ok": False, "error": "read failed"})
            continue
        raw_bytes = bytes(raw)
        percent, source_type = battery_percent_candidate(raw_bytes)
        candidate = {
            "path": path,
            "ok": True,
            "raw": raw_bytes.hex(" "),
            "percent": percent,
            "source_type": source_type,
            "interpretations": lorax_interpretations(raw_bytes),
        }
        candidates.append(candidate)
        if percent is not None:
            chosen.update(
                {
                    "percent": percent,
                    "source": path,
                    "source_type": source_type,
                    "raw": raw_bytes.hex(" "),
                }
            )
            return chosen

    cap_raw = await safe(device.get_battery_level)
    if cap_raw is not None:
        candidates.append(
            {
                "path": "/p/bat/cap",
                "ok": True,
                "raw_value": round(float(cap_raw), 3),
                "percent": None,
                "note": "Capacity telemetry is not treated as displayed percent; use /p/bat/soc or /p/bat/lev when available.",
            }
        )
        chosen.update({"source": "/p/bat/cap", "source_type": "capacity_raw", "raw": round(float(cap_raw), 3)})
    return chosen


def encode_lorax_value(value: Any, data_type: str) -> bytes:
    if data_type not in WRITE_TYPES:
        raise ValueError(f"Unsupported write type: {data_type}")
    if data_type == "bytes":
        if isinstance(value, str):
            clean = value.replace(" ", "")
            return bytes.fromhex(clean)
        return bytes(value)
    if data_type == "text":
        return str(value).encode("utf-8")
    formats = {
        "float32": "f",
        "int16": "h",
        "uint16": "H",
        "int32": "i",
        "uint32": "I",
        "uint8": "B",
        "int8": "b",
        "bool": "?",
    }
    typed_value: Any = bool(value) if data_type == "bool" else float(value) if data_type == "float32" else int(value)
    return struct.pack(f"<{formats[data_type]}", typed_value)


async def read_lorax_path(identifier: str, *, offset: int = 0, size: int | None = None, data_type: str | None = None) -> dict[str, Any]:
    if not device:
        raise RuntimeError("Device not connected")
    entry = resolve_lorax_path(identifier)
    read_type = data_type or entry.data_type
    read_size = size or entry.size
    raw = await device.read_short(entry.path, offset, read_size)
    return {
        "path": entry.path,
        "name": entry.name,
        "function": entry.function,
        "status": entry.status,
        "access": entry.access,
        "type": read_type,
        "offset": offset,
        "size": read_size,
        "raw": raw.hex(" "),
        "value": decode_lorax_bytes(bytes(raw), read_type),
        "interpretations": lorax_interpretations(bytes(raw)),
    }


async def write_lorax_path(identifier: str, value: Any, *, offset: int = 0, data_type: str | None = None, confirm: str | None = None) -> dict[str, Any]:
    if not device:
        raise RuntimeError("Device not connected")
    entry = resolve_lorax_path(identifier)
    if entry.access == "read":
        raise ValueError(f"{entry.path} is registered as read-only")
    if entry.dangerous and confirm not in {"WRITE", "RESET"}:
        raise ValueError(f"{entry.path} is dangerous and requires confirm='WRITE'")
    write_type = data_type or (entry.data_type if entry.data_type in WRITE_TYPES else "bytes")
    payload = encode_lorax_value(value, write_type)
    await device.write_short(entry.path, offset, 0, payload)
    return {
        "path": entry.path,
        "name": entry.name,
        "function": entry.function,
        "type": write_type,
        "offset": offset,
        "raw": payload.hex(" "),
    }


async def probe_lorax_paths(params: dict[str, Any]) -> dict[str, Any]:
    if not device:
        raise RuntimeError("Device not connected")
    selected = select_paths(
        category=params.get("category"),
        status=params.get("status"),
        names=params.get("paths") or params.get("names"),
    )
    limit = int(params.get("limit", 50))
    size_override = params.get("size")
    results = []
    for entry in selected[:limit]:
        size = int(size_override or entry.size)
        try:
            raw = await device.read_short(entry.path, 0, size)
            results.append(
                {
                    "path": entry.path,
                    "name": entry.name,
                    "function": entry.function,
                    "status": entry.status,
                    "category": entry.category,
                    "ok": True,
                    "empty": len(raw) == 0,
                    "interpretations": lorax_interpretations(bytes(raw)),
                }
            )
        except Exception as exc:
            results.append(
                {
                    "path": entry.path,
                    "name": entry.name,
                    "function": entry.function,
                    "status": entry.status,
                    "category": entry.category,
                    "ok": False,
                    "error": f"{type(exc).__name__}: {exc}",
                }
            )
    return {"count": len(results), "results": results}


async def observe_lorax_paths(params: dict[str, Any]) -> dict[str, Any]:
    if not device:
        raise RuntimeError("Device not connected")
    selected = select_paths(
        category=params.get("category"),
        status=params.get("status"),
        names=params.get("paths") or params.get("names"),
    )
    limit = int(params.get("limit", 20))
    samples = max(1, min(60, int(params.get("samples", 8))))
    interval = max(0.2, min(10.0, float(params.get("interval", 1.0))))
    size_override = params.get("size")
    selected = selected[:limit]
    series: dict[str, dict[str, Any]] = {
        entry.path: {
            "path": entry.path,
            "name": entry.name,
            "function": entry.function,
            "status": entry.status,
            "category": entry.category,
            "samples": [],
        }
        for entry in selected
    }
    for sample_index in range(samples):
        sample_time = datetime.now().isoformat(timespec="seconds")
        for entry in selected:
            size = int(size_override or entry.size)
            try:
                raw = await device.read_short(entry.path, 0, size)
                series[entry.path]["samples"].append(
                    {
                        "index": sample_index,
                        "time": sample_time,
                        "ok": True,
                        "interpretations": lorax_interpretations(bytes(raw)),
                    }
                )
            except Exception as exc:
                series[entry.path]["samples"].append(
                    {
                        "index": sample_index,
                        "time": sample_time,
                        "ok": False,
                        "error": f"{type(exc).__name__}: {exc}",
                    }
                )
        if sample_index < samples - 1:
            await asyncio.sleep(interval)
    results = []
    for item in series.values():
        raw_values = [
            sample.get("interpretations", {}).get("raw_hex")
            for sample in item["samples"]
            if sample.get("ok")
        ]
        item["changed"] = len(set(raw_values)) > 1
        item["non_empty"] = any(bool(value) for value in raw_values)
        results.append(item)
    return {
        "samples": samples,
        "interval_s": interval,
        "count": len(results),
        "results": results,
        "guidance": "A path is only a valid live metric if repeated samples change consistently with the physical event being tested.",
    }


def annotate_temperature_observation(result: dict[str, Any], *, promote: bool = False, require_change: bool = True) -> dict[str, Any]:
    ranked: list[dict[str, Any]] = []
    for item in result.get("results", []):
        best = summarize_temperature_samples(item.get("samples", []))
        item["temperature_summary"] = best
        if best:
            ranked.append(
                {
                    "path": item.get("path"),
                    "name": item.get("name"),
                    "function": item.get("function"),
                    **best,
                }
            )
    ranked.sort(key=lambda entry: entry.get("score", 0), reverse=True)
    result["temperature_ranked"] = ranked
    result["temperature_promoted"] = None
    if promote and ranked:
        best = ranked[0]
        if best["samples"] >= 3 and (best["changed"] or not require_change):
            promoted_source = {
                "path": best["path"],
                "encoding": best["encoding"],
                "evidence": {
                    key: best[key]
                    for key in ("score", "samples", "changed", "trend", "first_f", "last_f", "min_f", "max_f", "range_f")
                },
            }
            set_live_temperature_source(promoted_source, persist=True)
            result["temperature_promoted"] = live_temperature_source
    return result


async def observe_temperature_paths(params: dict[str, Any]) -> dict[str, Any]:
    observe_params = {
        "category": "heater",
        "status": params.get("status", "experimental"),
        "limit": params.get("limit", 50),
        "size": params.get("size", 4),
        "samples": params.get("samples", 16),
        "interval": params.get("interval", 0.75),
    }
    if params.get("paths"):
        observe_params["paths"] = params["paths"]
    result = await observe_lorax_paths(observe_params)
    result["automatic"] = bool(params.get("automatic", False))
    result = annotate_temperature_observation(
        result,
        promote=bool(params.get("promote", False)),
        require_change=bool(params.get("require_change", True)),
    )
    result["mapped_temperature_source"] = live_temperature_source if live_temperature_source.get("path") else None
    result["guidance"] = (
        "Run once while idle, then run with promote=true during preheat/active heat. "
        "Promotion requires repeated plausible temperature samples and, by default, a changing value. "
        "After promotion, status snapshots include live_temperature and heat_report.current_temp_f from the mapped path."
    )
    return result


async def read_live_temperature() -> dict[str, Any] | None:
    if not device or not live_temperature_source.get("path"):
        return None
    path = live_temperature_source["path"]
    encoding = live_temperature_source["encoding"]
    raw = await safe(lambda: device.read_short(path, 0, 4))
    if raw is None:
        return {
            "path": path,
            "encoding": encoding,
            "ok": False,
            "error": "read failed",
            "evidence": live_temperature_source.get("evidence"),
        }
    raw_bytes = bytes(raw)
    value = temperature_value_from_raw(raw_bytes, encoding)
    return {
        "path": path,
        "encoding": encoding,
        "ok": value is not None,
        "raw": raw_bytes.hex(" "),
        "value_f": value.get("value_f") if value else None,
        "value_c": value.get("value_c") if value else None,
        "label": temperature_label(value.get("value_f")) if value else None,
        "evidence": live_temperature_source.get("evidence"),
        "interpretations": lorax_interpretations(raw_bytes),
    }


async def temperature_discovery_tick(snapshot: dict[str, Any]) -> dict[str, Any] | None:
    global temperature_discovery_index
    if not device or live_temperature_source.get("path"):
        return None
    if snapshot.get("heat") != "HEATING":
        temperature_discovery_samples.clear()
        return None

    candidates = select_paths(category="heater", status="experimental")
    if not candidates:
        return None

    entry = candidates[temperature_discovery_index % len(candidates)]
    temperature_discovery_index += 1
    sample_time = datetime.now().isoformat(timespec="seconds")
    item = temperature_discovery_samples.setdefault(
        entry.path,
        {
            "path": entry.path,
            "name": entry.name,
            "function": entry.function,
            "status": entry.status,
            "category": entry.category,
            "samples": [],
        },
    )

    try:
        raw = await device.read_short(entry.path, 0, 4)
        item["samples"].append(
            {
                "index": len(item["samples"]),
                "time": sample_time,
                "ok": True,
                "interpretations": lorax_interpretations(bytes(raw)),
            }
        )
    except Exception as exc:
        item["samples"].append(
            {
                "index": len(item["samples"]),
                "time": sample_time,
                "ok": False,
                "error": f"{type(exc).__name__}: {exc}",
            }
        )
    item["samples"] = item["samples"][-10:]
    item["temperature_summary"] = summarize_temperature_samples(item["samples"])

    ranked = []
    for known in temperature_discovery_samples.values():
        best = known.get("temperature_summary") or summarize_temperature_samples(known.get("samples", []))
        known["temperature_summary"] = best
        if best:
            ranked.append(
                {
                    "path": known["path"],
                    "name": known["name"],
                    "function": known["function"],
                    **best,
                }
            )
    ranked.sort(key=lambda row: row.get("score", 0), reverse=True)
    result: dict[str, Any] | None = None
    if ranked:
        result = {
            "automatic": True,
            "samples": 1,
            "interval_s": 1.0,
            "count": len(temperature_discovery_samples),
            "results": list(temperature_discovery_samples.values()),
            "temperature_ranked": ranked[:10],
            "temperature_promoted": None,
            "mapped_temperature_source": None,
            "guidance": "Automatic live-temperature discovery is sampling one heater path per status tick during real heat cycles.",
        }
        best = ranked[0]
        if best["samples"] >= 3 and best["changed"]:
            promoted_source = {
                "path": best["path"],
                "encoding": best["encoding"],
                "evidence": {
                    key: best[key]
                    for key in ("score", "samples", "changed", "trend", "first_f", "last_f", "min_f", "max_f", "range_f")
                },
            }
            set_live_temperature_source(promoted_source, persist=True)
            result["temperature_promoted"] = live_temperature_source
            result["mapped_temperature_source"] = live_temperature_source
    return result


def build_heat_report(data: dict[str, Any]) -> dict[str, Any]:
    global heat_session
    now = datetime.now()
    active = data.get("heat") == "HEATING"
    state = data.get("state")
    last_state = heat_session.get("last_state")
    if active and not heat_session.get("active"):
        heat_session = {
            "active": True,
            "started_at": now,
            "last_state": last_state,
            "timer_started_at": None,
            "timer_observed": False,
        }
    elif not active:
        heat_session = {"active": False, "last_state": state}

    state_key = normalized_state_key(state)
    if active and state_key == "HEAT_CYCLE_ACTIVE" and not heat_session.get("timer_started_at"):
        if normalized_state_key(last_state) == "HEAT_CYCLE_PREHEAT":
            heat_session["timer_started_at"] = now
            heat_session["timer_observed"] = True
        else:
            heat_session["timer_syncing"] = True
    if active:
        heat_session["last_state"] = state

    firmware_elapsed = seconds_value(data.get("state_elapsed_time_s"))
    firmware_total = seconds_value(data.get("state_total_time_s"))
    profile_duration = seconds_value(data.get("active_profile_time_s"))
    duration = profile_duration if profile_duration is not None else (firmware_total if active else None)
    started_at = heat_session.get("started_at")
    timer_started_at = heat_session.get("timer_started_at")
    timer_elapsed = None
    timer_remaining = None
    timer_confidence = "inactive"
    if active and state_key == "HEAT_CYCLE_ACTIVE":
        if firmware_elapsed is not None and duration is not None:
            timer_elapsed = max(0, firmware_elapsed)
            timer_remaining = max(0, duration - firmware_elapsed)
            timer_confidence = "firmware"
        elif timer_started_at and duration is not None:
            timer_elapsed = max(0, int((now - timer_started_at).total_seconds()))
            timer_remaining = max(0, duration - timer_elapsed)
            timer_confidence = "observed"
        else:
            timer_confidence = "syncing"
    elif active:
        timer_confidence = "preheating"

    phase = data.get("labels", {}).get("heat") or heat_label(data.get("state"), data.get("heat"))
    live_temp = data.get("live_temperature") or {}
    current_temp_f = (
        live_temp.get("value_f")
        if live_temp.get("ok")
        else data.get("current_temperature_f")
    )
    target_temp_f = valid_heat_target_f(data.get("target_temperature_f")) or valid_heat_target_f(data.get("active_profile_temp_f"))
    return {
        "active": active,
        "phase": phase or "Idle",
        "state": state,
        "state_label": data.get("labels", {}).get("state"),
        "selected_profile": data.get("current_profile"),
        "target_temp_f": target_temp_f,
        "target_temp_label": temperature_label(target_temp_f),
        "duration_s": duration,
        "duration_label": seconds_label(duration),
        "started_at": started_at.isoformat(timespec="seconds") if started_at else None,
        "timer_active": active and state_key == "HEAT_CYCLE_ACTIVE",
        "timer_started_at": timer_started_at.isoformat(timespec="seconds") if timer_started_at else None,
        "firmware_elapsed_s": firmware_elapsed,
        "firmware_total_s": firmware_total,
        "timer_elapsed_s": timer_elapsed,
        "timer_elapsed_label": seconds_label(timer_elapsed),
        "timer_remaining_s": timer_remaining,
        "timer_remaining_label": seconds_label(timer_remaining),
        "timer_confidence": timer_confidence,
        "timer_source": (
            "observed_active_transition_and_profile_duration"
            if timer_confidence == "observed"
            else "official_state_elapsed_and_total_time"
            if timer_confidence == "firmware"
            else "firmware_state_without_observed_active_transition"
            if timer_confidence == "syncing"
            else "firmware_state"
        ),
        "current_temp_f": current_temp_f,
        "current_temp_label": temperature_label(current_temp_f),
        "current_temp_path": live_temp.get("path") if live_temp.get("ok") else "/p/app/htr/temp",
        "current_temp_encoding": live_temp.get("encoding") if live_temp.get("ok") else "float32_c",
        "source": "official_lorax_state_and_temperature",
        "notes": (
            "Target, current chamber temperature, and firmware countdown come from official Puffco Lorax paths "
            "when available: /p/app/htr/temp, /p/app/htr/tcmd, /p/app/stat/elap, and /p/app/stat/tott."
        ),
    }


def apply_selected_profile_defaults(data: dict[str, Any]) -> None:
    profiles = data.get("profiles")
    if not isinstance(profiles, list):
        return
    try:
        selected = int(data.get("current_profile"))
    except (TypeError, ValueError):
        selected = None
    selected_profile = None
    for fallback_index, profile in enumerate(profiles):
        if not isinstance(profile, dict):
            continue
        try:
            profile_index = int(profile.get("index", fallback_index))
        except (TypeError, ValueError):
            profile_index = fallback_index
        if profile_index == selected:
            selected_profile = profile
            break
    if selected_profile is None:
        selected_profile = next(
            (profile for profile in profiles if isinstance(profile, dict) and profile.get("active")),
            None,
        )
    if not isinstance(selected_profile, dict):
        return
    if selected_profile.get("name"):
        data["active_profile_name"] = selected_profile.get("name")
    if selected_profile.get("temp_f") is not None:
        data["active_profile_temp_f"] = selected_profile.get("temp_f")
    if selected_profile.get("time_s") is not None:
        data["active_profile_time_s"] = selected_profile.get("time_s")


async def send_json(ws: Any, msg: dict[str, Any]) -> None:
    await ws.send(json.dumps(json_safe(msg), default=str, allow_nan=False))


async def broadcast(msg: dict[str, Any], *, exclude: Any | None = None) -> None:
    stale = []
    for ws in list(clients):
        if ws is exclude:
            continue
        try:
            await send_json(ws, msg)
        except Exception:
            stale.append(ws)
    for ws in stale:
        clients.discard(ws)


def json_safe(value: Any) -> Any:
    if isinstance(value, float):
        return value if math.isfinite(value) else None
    if isinstance(value, (bytes, bytearray)):
        return bytes(value).hex(" ")
    if isinstance(value, dict):
        return {key: json_safe(item) for key, item in value.items()}
    if isinstance(value, (list, tuple)):
        return [json_safe(item) for item in value]
    return value


async def broadcast_connection_status(stage: str, message: str, **data: Any) -> None:
    payload = {
        "stage": stage,
        "message": message,
        "timestamp": datetime.now().isoformat(timespec="seconds"),
        **data,
    }
    await broadcast({"type": "connection_status", "message": message, "data": payload})


async def device_snapshot(*, full: bool = True) -> dict[str, Any]:
    global snapshot_cache
    if not device or not device_connected:
        return disconnected_snapshot()
    if not ble_link_connected():
        return await mark_device_disconnected("Bluetooth link lost")

    data: dict[str, Any] = dict(snapshot_cache) if not full and snapshot_cache else {"connected": True}
    data["connected"] = True
    data.pop("error", None)
    try:
        if full or not data.get("name"):
            data["name"] = fmt(await safe(device.get_device_name))
        if full or not data.get("firmware"):
            data["firmware"] = fmt(await safe(device.get_software_version))
        if not data.get("firmware"):
            data["firmware"] = await read_version_label("/p/sys/fw/ver")
        if full or not data.get("bootloader"):
            data["bootloader"] = fmt(await safe(device.get_bootloader_version))
        if not data.get("bootloader"):
            data["bootloader"] = await read_version_label("/p/sys/fw/bver")
        if full or not data.get("serial"):
            data["serial"] = fmt(await safe(device.get_serial_number))
        if not data.get("serial"):
            data["serial"] = await read_text_label("/p/sys/hw/ser")

        battery_status = await read_battery_status()
        data["battery"] = battery_status.get("percent")
        data["battery_source"] = battery_status.get("source")
        data["battery_source_type"] = battery_status.get("source_type")
        data["battery_raw"] = battery_status.get("raw")
        data["battery_candidates"] = battery_status.get("candidates")

        charge = await safe(device.get_battery_charge_state)
        data["charge"] = state_name(charge) if charge is not None else None

        if full or not data.get("chamber"):
            chamber = await safe(device.get_chamber_type)
            data["chamber"] = state_name(chamber) if chamber is not None else None

        state = await safe(device.get_operating_state)
        data["state"] = state_name(state) if state is not None else None
        data["heat"] = heat_status(state) if state is not None else None

        official = await read_official_attributes(None if full else FAST_OFFICIAL_ATTRIBUTES)
        official_attrs = official.get("attributes", {})
        if not full and isinstance(data.get("official_attributes"), dict):
            merged_attrs = dict(data["official_attributes"])
            merged_attrs.update({key: value for key, value in official_attrs.items() if value is not None})
            official_attrs = merged_attrs
        data["official_attributes"] = official_attrs
        official_sources = official.get("sources") or {}
        if not full and isinstance(data.get("official_sources"), dict):
            merged_sources = dict(data["official_sources"])
            merged_sources.update(official_sources)
            data["official_sources"] = merged_sources
        else:
            data["official_sources"] = official_sources
        official_readable = official.get("readable") or {}
        if not full and isinstance(data.get("official_readable"), dict):
            merged_readable = dict(data["official_readable"])
            merged_readable.update({key: value for key, value in official_readable.items() if value is not None})
            data["official_readable"] = merged_readable
        else:
            data["official_readable"] = official_readable
        data["official_errors"] = official.get("errors")
        if official_attrs.get("batteryLevel") is not None:
            data["battery"] = official_attrs.get("batteryLevel")
            data["battery_source"] = "/p/bat/soc"
            data["battery_source_type"] = "official_battSoc_float32"
        if official_attrs.get("chargeState") is not None:
            data["charge"] = official_attrs.get("chargeState")
        if official_attrs.get("chamberType") is not None:
            data["chamber"] = official_attrs.get("chamberType")
        if official_attrs.get("operatingState") and not data.get("state"):
            data["state"] = official_attrs.get("operatingState")
            data["heat"] = heat_status(data["state"])
        data["state_elapsed_time_s"] = official_attrs.get("stateElapsedTime")
        data["state_total_time_s"] = official_attrs.get("stateTotalTime")
        official_field_map = {
            "chargeEstimatedTimeToFull": "charge_estimated_time_to_full_s",
            "lanternTime": "lantern_time_s",
            "lanternRemainingTime": "lantern_remaining_time_s",
            "boostTemperature": "boost_temperature_delta_c",
            "boostTime": "boost_time_s",
            "selectedHeatCycle": "selected_heat_cycle",
            "lowBatteryIndicator": "low_battery_indicator",
            "maxBatteryLevel": "max_battery_level",
            "brightness": "led_brightness",
        }
        for attr_name, field_name in official_field_map.items():
            if attr_name in official_attrs:
                data[field_name] = official_attrs.get(attr_name)
        if "boostTemperature" in official_attrs:
            if isinstance(data.get("boost_temperature_delta_c"), (int, float)):
                data["boost_temperature_delta_f"] = round(float(data["boost_temperature_delta_c"]) * 9 / 5, 1)
            else:
                data["boost_temperature_delta_f"] = None
        data["current_temperature_c"] = official_attrs.get("currentTemperature")
        data["target_temperature_c"] = official_attrs.get("targetTemperature")
        if isinstance(data.get("current_temperature_c"), (int, float)):
            data["current_temperature_f"] = round(fahrenheit_from_celsius(float(data["current_temperature_c"])), 1)
        if isinstance(data.get("target_temperature_c"), (int, float)) and float(data["target_temperature_c"]) >= 80:
            data["target_temperature_f"] = round(fahrenheit_from_celsius(float(data["target_temperature_c"])), 1)
        else:
            data["target_temperature_f"] = None

        if official_attrs.get("stealth") is not None:
            data["stealth"] = bool(official_attrs.get("stealth"))
        elif full or data.get("stealth") is None:
            stealth = await safe(device.is_stealth_mode)
            data["stealth"] = bool(stealth) if stealth is not None else None

        if official_attrs.get("lanternRemainingTime") is not None:
            data["lantern"] = float(official_attrs.get("lanternRemainingTime")) > 0
        elif full or data.get("lantern") is None:
            lantern = await safe(device.is_lantern_mode)
            data["lantern"] = bool(lantern) if lantern is not None else None

        if official_attrs.get("totalHeatCycles") is not None:
            data["total_dabs"] = official_attrs.get("totalHeatCycles")
        elif full or data.get("total_dabs") is None:
            data["total_dabs"] = await safe(device.get_total_dabs)
        if official_attrs.get("dabsPerDay") is not None:
            data["dabs_per_day"] = official_attrs.get("dabsPerDay")
        elif full or data.get("dabs_per_day") is None:
            data["dabs_per_day"] = await safe(lambda: read_float("/p/app/info/dpd"))
        if official_attrs.get("approxDabsRemaining") is not None:
            data["dabs_left"] = official_attrs.get("approxDabsRemaining")
        elif full or data.get("dabs_left") is None:
            data["dabs_left"] = await safe(lambda: read_float("/p/app/info/drem"))
        data["labels"] = snapshot_labels(data)
        data["readable"] = snapshot_readable(data)

        previous_profile_idx = data.get("current_profile")
        profile_idx = await safe(device.get_current_profile)
        data["current_profile"] = int(profile_idx) if profile_idx is not None else None
        profile_changed = previous_profile_idx != data.get("current_profile")
        if (
            full
            or profile_changed
            or data.get("active_profile_name") is None
            or data.get("active_profile_temp_f") is None
            or data.get("active_profile_time_s") is None
        ):
            data["active_profile_name"] = await safe(device.get_profile_name)
            data["active_profile_temp_f"] = await safe(device.get_profile_temp)
            data["active_profile_time_s"] = await safe(device.get_profile_time)
        data["live_temperature_source"] = live_temperature_source if live_temperature_source.get("path") else None
        data["live_temperature"] = await read_live_temperature()

        if full or not data.get("profiles"):
            profiles = []
            for index in range(PROFILE_COUNT):
                profile = {"index": index, "active": profile_idx == index}
                profile["name"] = fmt(await safe(lambda idx=index: device.get_profile_name(idx)))
                profile["temp_f"] = await safe(lambda idx=index: device.get_profile_temp(idx))
                profile["time_s"] = await safe(lambda idx=index: device.get_profile_time(idx))
                profile["color"] = await safe(lambda idx=index: device.get_profile_colours(idx))
                profile["labels"] = {
                    "status": "Active" if profile["active"] else "Inactive",
                    "temperature": temperature_label(profile["temp_f"]),
                    "duration": seconds_label(profile["time_s"]),
                }
                profiles.append(profile)
            data["profiles"] = profiles
        elif data.get("profiles"):
            for profile in data["profiles"]:
                profile["active"] = profile.get("index") == data.get("current_profile")
                labels = profile.setdefault("labels", {})
                labels["status"] = "Active" if profile["active"] else "Inactive"
        apply_selected_profile_defaults(data)
        data["heat_report"] = build_heat_report(data)
    except Exception as exc:
        data["error"] = f"{type(exc).__name__}: {exc}"

    data["timestamp"] = datetime.now().isoformat(timespec="seconds")
    data["backend"] = {
        "transport": "windows_python_ble",
        "device_connected_flag": bool(device_connected),
        "ble_link_connected": bool(ble_link_connected()),
        "session_id": getattr(device, "session_id", None) if device else None,
        "polling": bool(poll_task and not poll_task.done()),
        "poll_interval_s": 1.0,
        "connection_operation_busy": bool(connection_lock and connection_lock.locked()),
        "command_operation_busy": bool(command_lock and command_lock.locked()),
        "ignored_disconnect_callbacks": ignored_disconnect_callbacks,
        "snapshot_mode": "full" if full else "fast",
        "background_reads_paused": asyncio.get_running_loop().time() < background_reads_paused_until,
        "active_clients": len(clients),
    }
    if data.get("connected"):
        snapshot_cache = data.copy()
    return data


async def locked_device_snapshot(*, full: bool = True) -> dict[str, Any]:
    if device_connected and command_lock:
        async with command_lock:
            return await device_snapshot(full=full)
    return await device_snapshot(full=full)


async def poll_device_status() -> None:
    while device_connected:
        loop = asyncio.get_running_loop()
        if loop.time() < background_reads_paused_until:
            await asyncio.sleep(0.05)
            continue
        try:
            if command_lock:
                async with command_lock:
                    snapshot = await device_snapshot(full=False)
                    discovery = await temperature_discovery_tick(snapshot)
            else:
                snapshot = await device_snapshot(full=False)
                discovery = await temperature_discovery_tick(snapshot)
            await broadcast({"type": "status", "data": snapshot})
            if discovery:
                await broadcast({"type": "temperature_observe", "data": discovery})
            if not snapshot.get("connected"):
                await broadcast({"type": "disconnected", "message": snapshot.get("disconnect_reason", "Device disconnected")})
                break
        except Exception as exc:
            snapshot = await mark_device_disconnected(f"Read error: {exc}")
            await broadcast({"type": "error", "message": f"Background polling error: {exc}"})
            await broadcast({"type": "disconnected", "message": "Disconnected due to read error", "data": snapshot})
            break
        await asyncio.sleep(1.0)


def start_polling() -> None:
    global poll_task
    if not poll_task or poll_task.done():
        poll_task = asyncio.create_task(poll_device_status())


def stop_polling() -> None:
    global poll_task
    if poll_task and not poll_task.done():
        poll_task.cancel()
    poll_task = None
    temperature_discovery_samples.clear()


async def handle_connect(params: dict[str, Any]) -> dict[str, Any]:
    if connection_lock:
        if connection_lock.locked():
            return {
                "type": "error",
                "message": "A Bluetooth connection operation is already running. Wait for it to finish, then retry.",
                "data": {
                    "stage": "busy",
                    "hint": "Avoid pressing connect from multiple browser tabs at the same time.",
                },
            }
        async with connection_lock:
            return await handle_connect_locked(params)
    return await handle_connect_locked(params)


async def handle_connect_locked(params: dict[str, Any]) -> dict[str, Any]:
    global device, device_connected
    if device_connected and ble_link_connected():
        snapshot = enforce_connected_snapshot(await device_snapshot(full=False))
        start_polling()
        await broadcast_connection_status(
            "synced",
            "Browser synced to the active backend BLE session.",
            connected=True,
        )
        return {
            "type": "connected",
            "data": snapshot,
            "message": "Already connected; synced the browser UI to the active backend BLE session.",
        }
    if device_connected or device:
        await broadcast_connection_status("resetting", "Resetting stale BLE session before reconnect.")
        await mark_device_disconnected("Resetting stale BLE session before reconnect")

    device_name = params.get("device", "Peak")
    mac = params.get("mac") or None
    attempts: list[dict[str, Any]] = []
    cache_modes = (False, True, False)
    await broadcast_connection_status(
        "starting",
        "Starting Windows Bluetooth connection.",
        target=mac or device_name,
        attempts=len(cache_modes),
    )

    for attempt, use_cached_services in enumerate(cache_modes, start=1):
        await broadcast_connection_status(
            "connecting",
            f"Bluetooth handshake attempt {attempt}/{len(cache_modes)}.",
            attempt=attempt,
            attempts=len(cache_modes),
            use_cached_services=use_cached_services,
            target=mac or device_name,
        )
        candidate = WebPuffcoBLE(
            device_name=None if mac else device_name,
            device_mac=mac,
            debug=SERVER_VERBOSE,
            use_cached_services=use_cached_services,
        )
        candidate.session_id = next(connection_session_counter)
        try:
            await asyncio.wait_for(candidate.connect(), timeout=35)
            device = candidate
            device_connected = True
            snapshot = enforce_connected_snapshot(await device_snapshot(full=False))
            start_polling()
            await broadcast_connection_status(
                "connected",
                "Bluetooth link is connected and the UI snapshot is live.",
                connected=True,
                name=snapshot.get("name"),
                address=snapshot.get("address"),
                session_id=candidate.session_id,
            )
            return {
                "type": "connected",
                "data": snapshot,
                "message": (
                    "Connected through Windows Bluetooth. Browser Bluetooth permission dialogs are not used "
                    "because the local Python backend owns the BLE connection."
                ),
            }
        except Exception as exc:
            hint = ble_error_hint(exc)
            attempts.append(
                {
                    "attempt": attempt,
                    "use_cached_services": use_cached_services,
                    "error": f"{type(exc).__name__}: {exc}",
                    "hint": hint,
                }
            )
            try:
                await candidate.disconnect()
            except Exception:
                pass
            device_connected = False
            device = None
            if attempt < len(cache_modes):
                await broadcast_connection_status(
                    "retrying",
                    f"Attempt {attempt} failed; retrying with a different Windows GATT cache mode.",
                    attempt=attempt,
                    attempts=len(cache_modes),
                    error=f"{type(exc).__name__}: {exc}",
                    hint=hint,
                )
                await asyncio.sleep(0.8 + attempt * 0.7)

    if attempts:
        last = attempts[-1]
        hint = last.get("hint") or "Retry after waking the Puffco and making sure the official app is closed."
        message = f"Connect failed after {len(attempts)} attempts: {last['error']}. {hint}"
    else:
        message = "Connect failed before any BLE attempt was made."
    await broadcast_connection_status("failed", message, attempts=attempts)
    return {"type": "error", "message": message, "data": {"attempts": attempts, "stage": "failed"}}


async def handle_disconnect(_params: dict[str, Any]) -> dict[str, Any]:
    if connection_lock:
        if connection_lock.locked():
            return {
                "type": "error",
                "message": "Bluetooth is busy connecting or scanning. Wait for that operation to finish before disconnecting.",
                "data": {"stage": "busy"},
            }
        async with connection_lock:
            return await handle_disconnect_locked(_params)
    return await handle_disconnect_locked(_params)


async def handle_disconnect_locked(_params: dict[str, Any]) -> dict[str, Any]:
    await broadcast_connection_status("disconnecting", "Disconnecting Bluetooth session.")
    snapshot = await mark_device_disconnected("User disconnected")
    await broadcast({"type": "disconnected", "message": "User disconnected", "data": snapshot})
    return {"type": "disconnected", "message": "Disconnected", "data": snapshot}


async def handle_scan_devices(params: dict[str, Any]) -> dict[str, Any]:
    if connection_lock:
        if connection_lock.locked():
            return {
                "type": "scan_devices",
                "data": {
                    "devices": [],
                    "backend": "windows_python_ble",
                    "note": "Bluetooth is busy connecting or disconnecting. Try scanning again in a moment.",
                },
            }
        async with connection_lock:
            return await handle_scan_devices_locked(params)
    return await handle_scan_devices_locked(params)


async def handle_scan_devices_locked(params: dict[str, Any]) -> dict[str, Any]:
    if device_connected:
        return {
            "type": "scan_devices",
            "data": {
                "devices": [],
                "backend": "windows_python_ble",
                "note": "Disconnect before scanning for another device.",
            },
        }
    timeout = params.get("timeout", 6)
    try:
        timeout = max(2.0, min(15.0, float(timeout)))
    except (TypeError, ValueError):
        timeout = 6.0
    await broadcast_connection_status("scanning", f"Scanning Windows Bluetooth for Puffco devices ({timeout:.0f}s).")
    devices = await BleakScanner.discover(timeout=timeout, return_adv=True)
    rows: list[dict[str, Any]] = []
    seen: set[str] = set()
    for address, (item, adv) in devices.items():
        name = item.name or adv.local_name or ""
        if not address or address in seen:
            continue
        seen.add(address)
        lower_name = name.lower()
        likely_puffco = any(token in lower_name for token in ("peak", "pearl", "puffco", "proxy"))
        if not likely_puffco and params.get("puffco_only", True):
            continue
        rows.append(
            {
                "name": name or "Unknown BLE device",
                "address": address,
                "rssi": adv.rssi,
                "likely_puffco": likely_puffco,
            }
        )
    rows.sort(key=lambda row: (not row["likely_puffco"], row["name"].lower(), row["address"]))
    return {
        "type": "scan_devices",
        "data": {
            "devices": rows,
            "backend": "windows_python_ble",
            "timeout_s": timeout,
        },
    }


async def handle_status(_params: dict[str, Any]) -> dict[str, Any]:
    return {"type": "status", "data": await locked_device_snapshot(full=False)}


async def handle_lorax_registry(params: dict[str, Any]) -> dict[str, Any]:
    payload = registry_payload()
    category = params.get("category")
    status = params.get("status")
    if category or status:
        payload["paths"] = [
            entry.to_dict()
            for entry in select_paths(category=category, status=status)
        ]
    return {"type": "lorax_registry", "data": payload}


async def handle_lorax_read(params: dict[str, Any]) -> dict[str, Any]:
    result = await read_lorax_path(
        params["path"],
        offset=int(params.get("offset", 0)),
        size=int(params["size"]) if params.get("size") is not None else None,
        data_type=params.get("type"),
    )
    return {"type": "lorax_read", "data": result}


async def handle_lorax_probe(params: dict[str, Any]) -> dict[str, Any]:
    return {"type": "lorax_probe", "data": await probe_lorax_paths(params)}


async def handle_lorax_observe(params: dict[str, Any]) -> dict[str, Any]:
    return {"type": "lorax_observe", "data": await observe_lorax_paths(params)}


async def handle_heat_probe(params: dict[str, Any]) -> dict[str, Any]:
    probe_params = {
        "category": "heater",
        "status": params.get("status", "experimental"),
        "limit": params.get("limit", 50),
        "size": params.get("size", 4),
    }
    if params.get("paths"):
        probe_params["paths"] = params["paths"]
    result = await probe_lorax_paths(probe_params)
    result["guidance"] = (
        "Run this while idle and again during preheat/active heat. A real live "
        "temperature path should return data and change in the expected direction; "
        "do not map a path as current temperature until that behavior is observed."
    )
    return {"type": "heat_probe", "data": result}


async def handle_heat_observe(params: dict[str, Any]) -> dict[str, Any]:
    observe_params = {
        "status": params.get("status", "experimental"),
        "limit": params.get("limit", 50),
        "size": params.get("size", 4),
        "samples": params.get("samples", 16),
        "interval": params.get("interval", 0.75),
        "promote": params.get("promote", False),
        "require_change": params.get("require_change", True),
    }
    if params.get("paths"):
        observe_params["paths"] = params["paths"]
    result = await observe_temperature_paths(observe_params)
    return {"type": "heat_observe", "data": result}


async def handle_temperature_observe(params: dict[str, Any]) -> dict[str, Any]:
    return {"type": "temperature_observe", "data": await observe_temperature_paths(params)}


async def handle_temperature_source(params: dict[str, Any]) -> dict[str, Any]:
    if params.get("clear"):
        return {"type": "temperature_source", "data": set_live_temperature_source(None)}
    path = params.get("path")
    encoding = params.get("encoding")
    if path and encoding:
        if path not in PATHS_BY_PATH:
            return {"type": "error", "message": f"Unknown Lorax path: {path}"}
        set_live_temperature_source(
            {
                "path": path,
                "encoding": encoding,
                "evidence": {"manual": True, "note": "Manually selected by user command."},
            }
        )
    return {"type": "temperature_source", "data": live_temperature_source if live_temperature_source.get("path") else None}


async def handle_official_attributes(params: dict[str, Any]) -> dict[str, Any]:
    requested = params.get("names") or params.get("attributes")
    names = tuple(str(name) for name in requested) if isinstance(requested, list) else None
    return {"type": "official_attributes", "data": await read_official_attributes(names)}


async def handle_lorax_write(params: dict[str, Any]) -> dict[str, Any]:
    result = await write_lorax_path(
        params["path"],
        params["value"],
        offset=int(params.get("offset", 0)),
        data_type=params.get("type"),
        confirm=params.get("confirm"),
    )
    return {"type": "ok", "message": f"Wrote {result['name']}", "data": result}


async def handle_lorax_action(params: dict[str, Any]) -> dict[str, Any]:
    action_name = params["action"]
    action = ACTION_COMMANDS.get(action_name)
    if not action:
        return {"type": "error", "message": f"Unknown Lorax action: {action_name}"}
    if action.get("dangerous") and params.get("confirm") != action.get("confirm", "WRITE"):
        return {"type": "error", "message": f"{action_name} requires confirm='{action.get('confirm', 'WRITE')}'"}
    result = await write_lorax_path(
        action["path"],
        params.get("value", action["value"]),
        data_type=action["type"],
        confirm=params.get("confirm") or ("WRITE" if action.get("dangerous") else None),
    )
    return {
        "type": "ok",
        "message": f"Lorax action {action_name} sent",
        "data": {"action": action_name, "write": result, "status": await device_snapshot(full=False)},
    }


async def wait_for_heat_state(expect_heating: bool, *, timeout: float = 2.5) -> dict[str, Any]:
    deadline = asyncio.get_running_loop().time() + timeout
    snapshot = await device_snapshot(full=False)
    while asyncio.get_running_loop().time() < deadline:
        if bool(snapshot.get("heat") == "HEATING") is expect_heating:
            return snapshot
        await asyncio.sleep(0.25)
        snapshot = await device_snapshot(full=False)
    return snapshot


def status_payload_from_response(response: dict[str, Any]) -> dict[str, Any] | None:
    data = response.get("data")
    if not isinstance(data, dict):
        return None
    nested = data.get("status")
    if isinstance(nested, dict):
        return nested
    if (
        data.get("connected") in {True, False}
        or "heat_report" in data
        or "official_attributes" in data
        or "readable" in data
        or "labels" in data
    ):
        return data
    return None


async def handle_select_profile(params: dict[str, Any]) -> dict[str, Any]:
    index = profile_index(params["index"])
    await device.set_current_profile(index)
    return {"type": "ok", "message": f"Selected profile {index}", "data": await device_snapshot(full=False)}


async def handle_set_profile(params: dict[str, Any]) -> dict[str, Any]:
    index = profile_index(params["index"])
    changed = []
    expected_mood_payload = None
    if params.get("name") is not None:
        await device.write_short(f"/u/app/hc/{index}/name", 0, 0, profile_name_bytes(str(params["name"])))
        changed.append("name")
    if params.get("temp_f") is not None:
        temp_c = (temp_f_value(params["temp_f"]) - 32) / 1.8
        await device.write_short(f"/u/app/hc/{index}/temp", 0, 0, struct.pack("<f", temp_c))
        changed.append("temp")
    if params.get("time_s") is not None:
        await device.write_short(f"/u/app/hc/{index}/time", 0, 0, struct.pack("<f", profile_seconds_value(params["time_s"])))
        changed.append("time")
    if params.get("color") is not None:
        expected_mood_payload = profile_colour_payload(params["color"])
        await device.set_profile_colour(index, colour=expected_mood_payload)
        changed.append("color")
    if isinstance(params.get("mood_light"), dict):
        mood = params["mood_light"]
        expected_mood_payload = mood_light_payload(
            str(mood.get("preset") or mood.get("mood") or "no_animation"),
            mood.get("colors"),
            tempo_frac=mood.get("tempo_frac", mood.get("tempoFrac", 0.5)),
            dynamic_inhale=mood.get("dynamic_inhale", mood.get("dynamicInhale", False)),
        )
        await device.set_profile_colour(
            index,
            colour=expected_mood_payload,
        )
        changed.append("mood light")
    if params.get("select"):
        await device.set_current_profile(index)
        changed.append("selected")
    snapshot = await device_snapshot(full=True)
    snapshot["write_verification"] = verify_profile_write(snapshot, index, params, expected_mood_payload)
    return {
        "type": "ok",
        "message": f"Updated profile {index}: {', '.join(changed) or 'nothing'}",
        "data": snapshot,
    }


async def handle_set_color(params: dict[str, Any]) -> dict[str, Any]:
    index = params.get("index")
    if index is not None:
        index = profile_index(index)
    color = hex_color(params["hex"])
    payload = profile_colour_payload(color)
    await device.set_profile_colour(index, colour=payload)
    target = "current profile" if index is None else f"profile {index}"
    snapshot = await device_snapshot(full=True)
    verify_index = snapshot.get("current_profile") if index is None else index
    if verify_index is not None:
        snapshot["write_verification"] = verify_profile_write(
            snapshot,
            profile_index(verify_index),
            {"color": color},
            payload,
        )
    return {"type": "ok", "message": f"Set {target} color to {color}", "data": snapshot}


async def handle_mood_light(params: dict[str, Any]) -> dict[str, Any]:
    index = params.get("index")
    if index is not None:
        index = profile_index(index)
    preset = params.get("preset") or params.get("mood") or "no_animation"
    colors = params.get("colors")
    if colors is None and params.get("hex"):
        colors = [params["hex"]]
    payload = mood_light_payload(
        str(preset),
        colors,
        tempo_frac=params.get("tempo_frac", params.get("tempoFrac", 0.5)),
        dynamic_inhale=params.get("dynamic_inhale", params.get("dynamicInhale", False)),
    )
    await device.set_profile_colour(index, colour=payload)
    target = "current profile" if index is None else f"profile {index}"
    name = payload.get("meta", {}).get("moodName") or str(preset)
    snapshot = await device_snapshot(full=True)
    verify_index = snapshot.get("current_profile") if index is None else index
    if verify_index is not None:
        snapshot["write_verification"] = verify_profile_write(
            snapshot,
            profile_index(verify_index),
            {"mood_light": params},
            payload,
        )
    return {"type": "ok", "message": f"Applied {name} mood light to {target}", "data": snapshot}


async def handle_lantern(params: dict[str, Any]) -> dict[str, Any]:
    state = params.get("state", "on")
    enabled = state == "on"
    if state == "on":
        await device.start_lantern()
    else:
        await device.stop_lantern()
    snapshot_cache["lantern"] = enabled
    return {"type": "ok", "message": f"Lantern {state}", "data": await device_snapshot(full=False)}


async def handle_lantern_color(params: dict[str, Any]) -> dict[str, Any]:
    preset = params.get("preset") or params.get("mood")
    if preset:
        payload = mood_light_payload(
            str(preset),
            params.get("colors"),
            tempo_frac=params.get("tempo_frac", params.get("tempoFrac", 0.5)),
            dynamic_inhale=params.get("dynamic_inhale", params.get("dynamicInhale", False)),
        )
        color = payload.get("meta", {}).get("moodName") or str(preset)
    else:
        color = hex_color(params["hex"])
        payload = profile_colour_payload(color)
    await device.set_profile_colour(None, colour=payload)
    await device.start_lantern()
    snapshot_cache["lantern"] = True
    return {"type": "ok", "message": f"Lantern color set to {color}", "data": await device_snapshot(full=True)}


async def handle_stealth(params: dict[str, Any]) -> dict[str, Any]:
    state = params.get("state", "on")
    enabled = state == "on"
    await device.set_stealth_mode(enabled)
    snapshot_cache["stealth"] = enabled
    return {"type": "ok", "message": f"Stealth {state}", "data": await device_snapshot(full=False)}


async def handle_brightness(params: dict[str, Any]) -> dict[str, Any]:
    all_value = params.get("all")
    base_pct = percent_value(params.get("base", all_value if all_value is not None else 50))
    mid_pct = percent_value(params.get("mid", all_value if all_value is not None else 50))
    glass_pct = percent_value(params.get("glass", all_value if all_value is not None else 50))
    logo_pct = percent_value(params.get("logo", all_value if all_value is not None else 50))
    await device.set_led_brightness(
        percent_to_byte(base_pct),
        percent_to_byte(mid_pct),
        percent_to_byte(glass_pct),
        percent_to_byte(logo_pct),
    )
    return {
        "type": "ok",
        "message": f"Brightness set: base={base_pct}% mid={mid_pct}% glass={glass_pct}% logo={logo_pct}%",
        "data": await device_snapshot(full=True),
    }


async def handle_show_battery(_params: dict[str, Any]) -> dict[str, Any]:
    await device.show_battery_level()
    return {"type": "ok", "message": "Battery level shown on device LEDs", "data": await device_snapshot(full=False)}


async def handle_show_version(_params: dict[str, Any]) -> dict[str, Any]:
    await device.show_version()
    return {"type": "ok", "message": "Version pattern shown on device LEDs", "data": await device_snapshot(full=False)}


async def handle_heat(_params: dict[str, Any]) -> dict[str, Any]:
    state = await safe(device.get_operating_state)
    if state is not None and is_heat_state(state):
        return {"type": "ok", "message": "Heat cycle already active", "data": await device_snapshot(full=False)}
    await device.start_heat_cycle()
    return {"type": "ok", "message": "Heat cycle start command sent", "data": await wait_for_heat_state(True)}


async def handle_stop(_params: dict[str, Any]) -> dict[str, Any]:
    await device.stop_heat_cycle()
    return {"type": "ok", "message": "Heat cycle stop command sent", "data": await wait_for_heat_state(False)}


async def handle_boost(_params: dict[str, Any]) -> dict[str, Any]:
    state = await safe(device.get_operating_state)
    if state is not None and not is_heat_state(state):
        return {"type": "error", "message": "Boost is only available during a heat cycle"}
    await device.boost_heat_cycle()
    return {"type": "ok", "message": "Boost sent", "data": await device_snapshot(full=False)}


async def handle_set_boost_options(params: dict[str, Any]) -> dict[str, Any]:
    if not device or not device_connected:
        return {"type": "error", "message": "Device is not connected"}
    temp_f = params.get("temp_delta_f", params.get("temp_f"))
    time_s = params.get("time_s", params.get("seconds"))
    try:
        temp_f_value = float(temp_f)
        time_value = float(time_s)
    except (TypeError, ValueError):
        return {"type": "error", "message": "Boost options require temp_delta_f and time_s numbers"}
    if not 0 <= temp_f_value <= 120:
        return {"type": "error", "message": "Boost temperature must be 0-120 F"}
    if not 0 <= time_value <= 180:
        return {"type": "error", "message": "Boost time must be 0-180 seconds"}
    await device.write_short("/p/app/thc/btmp", 0, 0, struct.pack("<f", temp_f_value / 1.8))
    await device.write_short("/p/app/thc/btim", 0, 0, struct.pack("<f", time_value))
    snapshot = await device_snapshot(full=False)
    return {"type": "ok", "message": f"Boost options set to +{round(temp_f_value)} F / +{round(time_value)}s", "data": snapshot}


async def handle_power(params: dict[str, Any]) -> dict[str, Any]:
    cmd = params.get("cmd", "sleep")
    if cmd == "sleep":
        await device.enter_sleep_mode()
        await asyncio.sleep(0.4)
        return {"type": "ok", "message": "Sleep command sent", "data": await device_snapshot(full=False)}
    if cmd == "off":
        await device.power_off()
        await asyncio.sleep(0.4)
        snapshot = await mark_device_disconnected("Device powered off")
        return {"type": "disconnected", "message": "Device powered off", "data": snapshot}
    if cmd == "factory_reset":
        if params.get("confirm") != "RESET":
            return {"type": "error", "message": "Factory reset requires confirmation"}
        await device.factory_reset()
        await asyncio.sleep(0.4)
        snapshot = await mark_device_disconnected("Factory reset command sent")
        return {"type": "disconnected", "message": "Factory reset command sent", "data": snapshot}
    return {"type": "error", "message": f"Unknown power command: {cmd}"}


COMMANDS = {
    "connect": handle_connect,
    "disconnect": handle_disconnect,
    "scan_devices": handle_scan_devices,
    "status": handle_status,
    "lorax_registry": handle_lorax_registry,
    "lorax_read": handle_lorax_read,
    "lorax_probe": handle_lorax_probe,
    "lorax_observe": handle_lorax_observe,
    "heat_probe": handle_heat_probe,
    "heat_observe": handle_heat_observe,
    "temperature_observe": handle_temperature_observe,
    "temperature_source": handle_temperature_source,
    "official_attributes": handle_official_attributes,
    "lorax_write": handle_lorax_write,
    "lorax_action": handle_lorax_action,
    "select_profile": handle_select_profile,
    "set_profile": handle_set_profile,
    "set_color": handle_set_color,
    "mood_light": handle_mood_light,
    "lantern": handle_lantern,
    "lantern_color": handle_lantern_color,
    "stealth": handle_stealth,
    "brightness": handle_brightness,
    "show_battery": handle_show_battery,
    "show_version": handle_show_version,
    "heat": handle_heat,
    "stop": handle_stop,
    "boost": handle_boost,
    "set_boost_options": handle_set_boost_options,
    "power": handle_power,
}
NO_DEVICE_COMMANDS = {"connect", "disconnect", "scan_devices", "status", "lorax_registry"}
READONLY_COMMANDS = {
    "status",
    "scan_devices",
    "lorax_registry",
    "lorax_read",
    "lorax_probe",
    "lorax_observe",
    "heat_probe",
    "heat_observe",
    "temperature_observe",
    "official_attributes",
}
MUTATING_COMMANDS = set(COMMANDS) - READONLY_COMMANDS
FULL_REFRESH_COMMANDS = {"select_profile", "set_profile", "set_color", "mood_light", "lantern_color"}
UNLOCKED_COMMANDS = {"connect", "disconnect", "scan_devices", "status", "lorax_registry"}


async def broadcast_status_after_command(*, full: bool = False, delay: float = 0.15) -> None:
    await asyncio.sleep(1.8 if full else delay)
    if not device_connected:
        return
    if command_lock and command_lock.locked():
        return
    try:
        if command_lock:
            async with command_lock:
                snapshot = await device_snapshot(full=full)
        else:
            snapshot = await device_snapshot(full=full)
        await broadcast({"type": "status", "data": snapshot})
    except Exception as exc:
        await broadcast({"type": "error", "message": f"Post-command status failed: {type(exc).__name__}: {exc}"})


async def websocket_endpoint(ws: Any) -> None:
    clients.add(ws)
    log_event("ws", "client connected", clients=len(clients))
    try:
        await send_json(ws, {"type": "status", "data": await locked_device_snapshot(full=False)})
        async for raw in ws:
            cmd_name = ""
            try:
                msg = json.loads(raw)
                cmd_name = msg.get("cmd", msg.get("type", ""))
                params = msg.get("params", {})
                log_event(
                    "ws",
                    "command received",
                    cmd=cmd_name,
                    params=",".join(params.keys()) if isinstance(params, dict) else type(params).__name__,
                )

                handler = COMMANDS.get(cmd_name)
                if not handler:
                    response = {"type": "error", "message": f"Unknown command: {cmd_name}"}
                elif cmd_name not in NO_DEVICE_COMMANDS and not device_connected:
                    response = {"type": "error", "message": "Not connected to device"}
                else:
                    if cmd_name in MUTATING_COMMANDS and device_connected:
                        pause_background_reads(0.45)
                    needs_lock = device_connected and cmd_name not in UNLOCKED_COMMANDS and command_lock
                    if needs_lock:
                        async with command_lock:
                            response = await handler(params)
                    else:
                        response = await handler(params)

                log_event("ws", "command response", cmd=cmd_name, result=summarize_ws_payload(response))
                broadcast_response = response.get("type") in {"connected", "disconnected"}
                if broadcast_response:
                    await broadcast(response)
                else:
                    await send_json(ws, response)

                if response.get("type") == "disconnected" and cmd_name != "disconnect" and not broadcast_response:
                    await broadcast(response, exclude=ws)
                elif cmd_name in MUTATING_COMMANDS and cmd_name != "disconnect":
                    status_payload = status_payload_from_response(response)
                    if status_payload:
                        await broadcast({"type": "status", "data": status_payload}, exclude=ws)
                    elif device_connected:
                        asyncio.create_task(
                            broadcast_status_after_command(full=cmd_name in FULL_REFRESH_COMMANDS)
                        )
            except json.JSONDecodeError:
                log_event("ws", "invalid json", level="WARN")
                await send_json(ws, {"type": "error", "message": "Invalid JSON"})
            except Exception as exc:
                log_event("ws", "command failed", level="ERROR", cmd=cmd_name, error=f"{type(exc).__name__}: {exc}")
                hint = ble_error_hint(exc)
                message = f"{type(exc).__name__}: {exc}"
                if hint:
                    message = f"{message}. {hint}"
                await send_json(ws, {"type": "error", "message": message})
                if cmd_name not in NO_DEVICE_COMMANDS and is_ble_connection_error(exc):
                    await broadcast_backend_disconnect("Bluetooth link became invalid; reconnect required")
                if SERVER_VERBOSE:
                    traceback.print_exc()
    except ConnectionClosed:
        pass
    finally:
        clients.discard(ws)
        log_event("ws", "client disconnected", clients=len(clients))


class WebHandler(BaseHTTPRequestHandler):
    def do_OPTIONS(self) -> None:
        self.send_response(204)
        self.send_cors_headers()
        self.send_header("Access-Control-Max-Age", "86400")
        self.end_headers()

    def do_GET(self) -> None:
        path = self.path.split("?", 1)[0]
        if path == "/api/health":
            self.send_json_response(
                200,
                {
                    "ok": True,
                    "connected": device_connected,
                    "timestamp": datetime.now().isoformat(timespec="seconds"),
                },
            )
            return
        if path == "/api/status":
            self.send_status_response()
            return
        if path == "/api/lorax/registry":
            self.send_json_response(200, registry_payload())
            return
        if path == "/":
            target = WEB_DIR / "index.html"
        elif path.startswith("/assets/"):
            target = WEB_DIR / path.removeprefix("/assets/")
        elif path in {"/manifest.json", "/sw.js"}:
            target = WEB_DIR / path.removeprefix("/")
        else:
            candidate = WEB_DIR / path.lstrip("/")
            target = candidate if candidate.is_file() else WEB_DIR / "index.html"

        try:
            data = target.read_bytes()
        except FileNotFoundError:
            self.send_error(404)
            return

        media_type = mimetypes.guess_type(str(target))[0] or "application/octet-stream"
        self.send_response(200)
        self.send_cors_headers()
        self.send_header("Content-Type", media_type)
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Cache-Control", "no-store, no-cache, must-revalidate, max-age=0")
        if target.name == "sw.js":
            self.send_header("Service-Worker-Allowed", "/")
        self.end_headers()
        self.wfile.write(data)

    def send_json_response(self, status: int, payload: dict[str, Any]) -> None:
        data = json.dumps(json_safe(payload), default=str, allow_nan=False).encode("utf-8")
        self.send_response(status)
        self.send_cors_headers()
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(data)

    def send_cors_headers(self) -> None:
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")

    def send_status_response(self) -> None:
        if not server_loop:
            self.send_json_response(503, {"connected": False, "error": "Server loop is not ready"})
            return
        future = asyncio.run_coroutine_threadsafe(locked_device_snapshot(full=False), server_loop)
        try:
            self.send_json_response(200, future.result(timeout=5))
        except FutureTimeoutError:
            self.send_json_response(504, {"connected": device_connected, "error": "Status read timed out"})
        except Exception as exc:
            self.send_json_response(500, {"connected": device_connected, "error": f"{type(exc).__name__}: {exc}"})

    def log_message(self, fmt_string: str, *args: Any) -> None:
        log_event("http", fmt_string % args, client=self.address_string())


def start_http_server(host: str, port: int) -> ThreadingHTTPServer:
    httpd = ThreadingHTTPServer((host, port), WebHandler)
    thread = threading.Thread(target=httpd.serve_forever, daemon=True)
    thread.start()
    return httpd


async def run(args: argparse.Namespace) -> None:
    global command_lock, connection_lock, device, device_connected, server_loop, SERVER_VERBOSE
    SERVER_VERBOSE = bool(args.verbose)
    command_lock = asyncio.Lock()
    connection_lock = asyncio.Lock()
    server_loop = asyncio.get_running_loop()
    httpd = start_http_server(args.host, args.port)
    url = f"http://{args.host}:{args.port}"
    ws_url = f"ws://{args.host}:{args.ws_port}/ws"
    log_event("server", "web app ready", url=url)
    log_event("server", "websocket ready", url=ws_url)
    log_event("server", "press Ctrl+C to stop", verbose=SERVER_VERBOSE)

    if args.open:
        webbrowser.open(url)

    try:
        async with serve(websocket_endpoint, args.host, args.ws_port):
            await asyncio.Future()
    finally:
        stop_polling()
        if device:
            try:
                await device.disconnect()
            except Exception:
                pass
        device_connected = False
        server_loop = None
        httpd.shutdown()


def parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(description="Run the Puffco BLE web controller")
    p.add_argument("--host", default="127.0.0.1")
    p.add_argument("--port", type=int, default=8420)
    p.add_argument("--ws-port", type=int, default=8421)
    p.add_argument("--open", action="store_true", help="Open the app in the default browser")
    p.add_argument("--verbose", action="store_true", help="Print verbose BLE tracebacks and Puffco protocol debug logs")
    return p


def main() -> None:
    try:
        if sys.version_info < (3, 14) and hasattr(asyncio, "WindowsProactorEventLoopPolicy"):
            asyncio.set_event_loop_policy(asyncio.WindowsProactorEventLoopPolicy())
        asyncio.run(run(parser().parse_args()))
    except KeyboardInterrupt:
        log_event("server", "stopped")


if __name__ == "__main__":
    main()
