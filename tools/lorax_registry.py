"""Known and discoverable Puffco Lorax path metadata.

This registry is intentionally conservative. Paths marked "known" are backed by
the vendored puffcoble implementation. Paths marked "experimental" came from
local probing scripts and should be read-only until a live device confirms them.
"""

from __future__ import annotations

from dataclasses import asdict, dataclass
from typing import Any


PROFILE_RANGE = range(4)
READ_TYPES = {"bytes", "float32", "int16", "uint16", "int32", "uint32", "uint8", "int8", "bool"}
WRITE_TYPES = {"bytes", "text", "float32", "int16", "uint16", "int32", "uint32", "uint8", "int8", "bool"}


@dataclass(frozen=True)
class LoraxPath:
    path: str
    name: str
    function: str
    access: str = "read"
    data_type: str = "bytes"
    size: int = 4
    category: str = "misc"
    status: str = "known"
    command: str | None = None
    notes: str = ""
    dangerous: bool = False

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)


def _profile_paths() -> list[LoraxPath]:
    paths: list[LoraxPath] = []
    for index in PROFILE_RANGE:
        base = f"/u/app/hc/{index}"
        paths.extend(
            [
                LoraxPath(
                    f"{base}/name",
                    f"profile_{index}_name",
                    f"Profile {index} user-visible name",
                    "read_write",
                    "text",
                    32,
                    "profile",
                    command="set_profile",
                ),
                LoraxPath(
                    f"{base}/temp",
                    f"profile_{index}_temperature",
                    f"Profile {index} target temperature, stored as Celsius float32",
                    "read_write",
                    "float32",
                    4,
                    "profile",
                    command="set_profile",
                    notes="UI converts Fahrenheit to Celsius before writing.",
                ),
                LoraxPath(
                    f"{base}/time",
                    f"profile_{index}_duration",
                    f"Profile {index} heat duration in seconds",
                    "read_write",
                    "float32",
                    4,
                    "profile",
                    command="set_profile",
                ),
                LoraxPath(
                    f"{base}/colr",
                    f"profile_{index}_color_animation",
                    f"Profile {index} color/animation CBOR payload",
                    "read_write",
                    "bytes",
                    125,
                    "profile",
                    command="set_color",
                    notes="Use high-level color command; raw payload is CBOR.",
                ),
            ]
        )
    return paths


KNOWN_PATHS: tuple[LoraxPath, ...] = (
    LoraxPath("/p/sys/hw/mdcd", "model_code", "Hardware model code", "read", "uint32", 4, "system"),
    LoraxPath("/p/sys/hw/ser", "serial_number", "Device serial number", "read", "text", 64, "system"),
    LoraxPath("/u/sys/name", "device_name", "User-visible Bluetooth/device name", "read", "text", 32, "system"),
    LoraxPath("/p/sys/fw/ver", "firmware_version", "Application firmware revision", "read", "uint8", 4, "system"),
    LoraxPath("/p/sys/fw/api", "api_version", "Lorax API version", "read", "uint32", 4, "system"),
    LoraxPath("/p/sys/fw/bver", "bootloader_version", "Bootloader revision", "read", "uint8", 4, "system"),
    LoraxPath("/p/sys/fw/bgit", "bootloader_git_hash", "Bootloader git hash", "read", "text", 64, "system"),
    LoraxPath("/p/sys/uptm", "uptime", "Device uptime bytes", "read", "bytes", 8, "system"),
    LoraxPath("/p/sys/time", "utc_time", "Device UTC clock as Unix seconds", "read_write", "uint32", 4, "system"),
    LoraxPath("/u/sys/bday", "device_birthday", "Device birthday/first setup time as Unix seconds", "read", "uint32", 4, "system"),
    LoraxPath("/p/htr/chmt", "chamber_type", "Detected chamber type", "read", "uint8", 1, "heater"),
    LoraxPath("/p/htr/chdt", "cable_handshake_detected", "Cable/chamber handshake detection counter", "read", "uint32", 4, "heater"),
    LoraxPath("/p/app/htr/temp", "current_temperature", "Official app live chamber temperature, Celsius float32", "read", "float32", 4, "heater", notes="Official Puffco app userHeaterTemp; watch at ~250 ms while dabbing."),
    LoraxPath("/p/app/htr/tcmd", "target_temperature", "Official app heater target temperature command, Celsius float32", "read", "float32", 4, "heater", notes="Official Puffco app userHeaterTempCommand."),
    LoraxPath("/p/htr/temp", "heater_temperature", "Lower-level live heater temperature, Celsius float32", "read", "float32", 4, "heater", notes="Official Puffco app heaterTemp."),
    LoraxPath("/p/htr/tcmd", "heater_target_temperature", "Lower-level heater target command, Celsius float32", "read", "float32", 4, "heater", notes="Official Puffco app heaterTempCommand."),
    LoraxPath("/p/htr/pwr", "heater_power", "Heater power telemetry", "read", "float32", 4, "heater"),
    LoraxPath("/p/htr/res", "heater_resistance", "Heater resistance telemetry", "read", "float32", 4, "heater"),
    LoraxPath("/p/htr/vavg", "heater_voltage", "Heater voltage telemetry", "read", "float32", 4, "heater"),
    LoraxPath("/p/bat/chg/stat", "battery_charge_state", "Battery charging state enum", "read", "uint8", 1, "battery"),
    LoraxPath("/p/bat/chg/etf", "battery_charge_estimated_time_to_full", "Estimated seconds/minutes to full charge", "read", "float32", 4, "battery", notes="Official app battChargeEstTimeToFull; unit appears firmware-defined."),
    LoraxPath("/p/bat/chg/src", "battery_charge_source", "Battery charge source enum", "read", "uint8", 1, "battery"),
    LoraxPath("/p/bat/chg/iout", "battery_charge_current", "Charging output current", "read", "float32", 4, "battery"),
    LoraxPath("/p/bat/chg/elap", "battery_charge_elapsed_time", "Charging elapsed time", "read", "float32", 4, "battery"),
    LoraxPath("/p/bat/soc", "battery_soc", "Displayed battery state of charge percent", "read", "float32", 4, "battery", notes="Official Puffco app battSoc; prefer this over /p/bat/cap for UI percent."),
    LoraxPath("/u/bat/msoc", "max_battery_soc", "Configured maximum battery state of charge percent", "read", "float32", 4, "battery"),
    LoraxPath("/p/bat/cap", "battery_capacity", "Battery capacity telemetry, not displayed percent", "read", "float32", 4, "battery"),
    LoraxPath("/p/bat/curr", "battery_current", "Battery current telemetry", "read", "float32", 4, "battery"),
    LoraxPath("/p/bat/volt", "battery_voltage", "Battery voltage telemetry", "read", "float32", 4, "battery"),
    LoraxPath("/p/bat/temp", "battery_temperature", "Battery temperature in Celsius", "read", "float32", 4, "battery"),
    LoraxPath("/u/app/lbws", "low_battery_warning_soc", "Low-battery warning threshold/state of charge", "read", "float32", 4, "battery"),
    LoraxPath("/p/app/stat/id", "operating_state", "Main app operating state enum", "read", "uint8", 1, "state"),
    LoraxPath("/p/app/stat/elap", "state_elapsed_time", "Elapsed time in current operating state, seconds float32", "read", "float32", 4, "state"),
    LoraxPath("/p/app/stat/tott", "state_total_time", "Total time for current operating state, seconds float32", "read", "float32", 4, "state"),
    LoraxPath("/p/app/info/dpd", "dabs_per_day", "Estimated dabs per day", "read", "float32", 4, "usage"),
    LoraxPath("/p/app/info/drem", "dabs_remaining", "Estimated dabs remaining before charge", "read", "float32", 4, "usage"),
    LoraxPath("/p/app/odom/0/nc", "total_heat_cycles", "Total completed heat cycles", "read", "float32", 4, "usage", notes="Official Puffco app totalHeatCycles."),
    LoraxPath("/p/app/odom/0/tm", "total_heat_cycle_time", "Total heat-cycle runtime", "read", "float32", 4, "usage", notes="Official Puffco app totalHeatCycleTime/dabTotalTime."),
    LoraxPath("/p/app/odom/1/nc", "trip_heat_cycles", "Trip heat-cycle count", "read", "float32", 4, "usage"),
    LoraxPath("/p/app/odom/1/tm", "trip_heat_cycle_time", "Trip heat-cycle runtime", "read", "float32", 4, "usage"),
    LoraxPath("/p/app/info/dtot", "total_dabs_candidate", "Total dab count on some firmware", "read", "uint32", 4, "usage", "known", notes="This returned empty on the user's firmware log."),
    LoraxPath("/p/app/mc", "mode_command", "Mode command byte mailbox", "write", "uint8", 1, "command", command="mode_command", notes="Values are ModeCommands enum.", dangerous=True),
    LoraxPath("/p/app/ltrn/cmd", "lantern_command", "Lantern on/off command and status", "read_write", "uint8", 1, "lighting", command="lantern"),
    LoraxPath("/p/app/ltrn/remt", "lantern_remaining_time", "Lantern remaining time", "read", "float32", 4, "lighting"),
    LoraxPath("/p/app/ltrn/time", "lantern_time", "Lantern configured time", "read", "float32", 4, "lighting"),
    LoraxPath("/u/app/ui/lbrt", "led_brightness", "LED brightness for base/mid/glass/logo channels", "read_write", "bytes", 4, "lighting", command="brightness"),
    LoraxPath("/u/app/ui/stlm", "stealth_mode", "Stealth mode flag", "read_write", "uint8", 1, "lighting", command="stealth"),
    LoraxPath("/p/logv/flt/end", "fault_log_end", "Fault log end index", "read", "uint32", 4, "logs"),
    LoraxPath("/p/logv/flt/begn", "fault_log_begin", "Fault log begin index", "read", "uint32", 4, "logs"),
    LoraxPath("/p/logv/flt/entr", "fault_log_entry", "Fault log entry payload", "read", "bytes", 125, "logs"),
    LoraxPath("/p/app/bt/ufca", "unexpected_ble_fault_absolute_count", "Unexpected BLE fault absolute count", "read", "uint32", 4, "logs"),
    LoraxPath("/p/app/bt/ufcc", "unexpected_ble_fault_credit_count", "Unexpected BLE fault credit count", "read", "uint32", 4, "logs"),
    LoraxPath("/p/app/facr", "factory_reset", "Factory reset trigger", "write", "uint8", 1, "power", command="factory_reset", dangerous=True),
    LoraxPath("/p/app/hcs", "current_profile", "Selected heat profile index", "read_write", "int8", 1, "profile", command="select_profile"),
    LoraxPath("/u/app/rdym/hc", "ready_mode_profile", "Ready-mode heat profile selection", "read_write", "float32", 4, "profile"),
    LoraxPath("/p/app/thc/name", "active_profile_name", "Selected profile name", "read", "text", 32, "profile"),
    LoraxPath("/p/app/thc/temp", "active_profile_temperature", "Selected profile target temperature, Celsius float32", "read", "float32", 4, "profile"),
    LoraxPath("/p/app/thc/time", "active_profile_duration", "Selected profile heat duration in seconds", "read", "float32", 4, "profile"),
    LoraxPath("/p/app/thc/btmp", "active_profile_boost_temperature_delta", "Selected profile boost temperature delta, Celsius float32", "read_write", "float32", 4, "profile", command="set_boost_options"),
    LoraxPath("/p/app/thc/btim", "active_profile_boost_time_delta", "Selected profile boost time delta, seconds float32", "read_write", "float32", 4, "profile", command="set_boost_options"),
    LoraxPath("/p/app/thc/colr", "active_profile_color_animation", "Selected profile color/animation CBOR payload", "read", "bytes", 125, "profile"),
    *_profile_paths(),
)


EXPERIMENTAL_USAGE_KEYS = (
    "dtotl",
    "dt",
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
EXPERIMENTAL_USAGE_PREFIXES = ("/p/app/info", "/p/app/stat", "/p/app", "/u/app/info", "/u/app")


def experimental_paths() -> list[LoraxPath]:
    paths: list[LoraxPath] = []
    for prefix in EXPERIMENTAL_USAGE_PREFIXES:
        for key in EXPERIMENTAL_USAGE_KEYS:
            path = f"{prefix}/{key}"
            if path in PATHS_BY_PATH:
                continue
            paths.append(
                LoraxPath(
                    path,
                    f"candidate_{prefix.strip('/').replace('/', '_')}_{key}",
                    "Candidate app/usage metric discovered by name probing",
                    "read",
                    "bytes",
                    12,
                    "usage",
                    "experimental",
                    notes="Probe read-only and interpret raw bytes before assigning a command.",
                )
            )
    paths.extend(
        [
            LoraxPath("/p/bat/volt", "battery_voltage_candidate", "Candidate battery voltage", "read", "bytes", 4, "battery", "experimental"),
            LoraxPath("/p/bat/soc", "battery_soc_candidate", "Candidate battery state of charge", "read", "bytes", 4, "battery", "experimental"),
            LoraxPath("/p/bat/lev", "battery_level_candidate", "Candidate battery level", "read", "bytes", 4, "battery", "experimental"),
        ]
    )
    temperature_candidates = {
        "/p/htr/temp": ("heater_temperature_candidate", "Candidate live heater temperature"),
        "/p/htr/tmpr": ("heater_temperature_short_candidate", "Candidate live heater temperature"),
        "/p/htr/ctmp": ("heater_current_temperature_candidate", "Candidate current heater temperature"),
        "/p/htr/tcur": ("heater_current_temperature_alt_candidate", "Candidate current heater temperature"),
        "/p/htr/tset": ("heater_target_candidate", "Candidate heater target temperature"),
        "/p/htr/targ": ("heater_target_alt_candidate", "Candidate heater target temperature"),
        "/p/htr/atmp": ("heater_ambient_temperature_candidate", "Candidate ambient/chamber baseline temperature"),
        "/p/htr/btmp": ("heater_battery_temperature_candidate", "Candidate battery/board temperature"),
        "/p/htr/otmp": ("heater_output_temperature_candidate", "Candidate output temperature"),
        "/p/htr/heat": ("heater_heat_metric_candidate", "Candidate heater heat metric"),
        "/p/app/info/ctmp": ("current_temperature_candidate", "Candidate current heat temperature"),
        "/p/app/info/temp": ("info_temperature_candidate", "Candidate current heat temperature"),
        "/p/app/stat/temp": ("state_temperature_candidate", "Candidate current heat temperature"),
        "/p/app/stat/ctmp": ("state_current_temperature_candidate", "Candidate current heat temperature"),
        "/p/app/temp": ("app_temperature_candidate", "Candidate current heat temperature"),
    }
    for path, (name, function) in temperature_candidates.items():
        if path in PATHS_BY_PATH:
            continue
        paths.append(
            LoraxPath(
                path,
                name,
                function,
                "read",
                "bytes",
                4,
                "heater",
                "experimental",
                notes="Read-only candidate. Promote only after repeated samples track real chamber temperature.",
            )
        )
    return paths


PATHS_BY_PATH: dict[str, LoraxPath] = {entry.path: entry for entry in KNOWN_PATHS}
ALL_PATHS: tuple[LoraxPath, ...] = (*KNOWN_PATHS, *experimental_paths())
PATHS_BY_PATH = {entry.path: entry for entry in ALL_PATHS}
PATHS_BY_NAME = {entry.name: entry for entry in ALL_PATHS}


MODE_COMMANDS = {
    "master_off": 0,
    "sleep": 1,
    "idle": 2,
    "temp_selection_begin": 3,
    "temp_selection_end": 4,
    "show_battery": 5,
    "show_version": 6,
    "heat_start": 7,
    "heat_stop": 8,
    "heat_boost": 9,
    "factory_test": 10,
    "bonding": 11,
}


ACTION_COMMANDS = {
    "heat_start": {"path": "/p/app/mc", "value": MODE_COMMANDS["heat_start"], "type": "uint8"},
    "heat_stop": {"path": "/p/app/mc", "value": MODE_COMMANDS["heat_stop"], "type": "uint8"},
    "heat_boost": {"path": "/p/app/mc", "value": MODE_COMMANDS["heat_boost"], "type": "uint8"},
    "sleep": {"path": "/p/app/mc", "value": MODE_COMMANDS["sleep"], "type": "uint8"},
    "power_off": {"path": "/p/app/mc", "value": MODE_COMMANDS["master_off"], "type": "uint8", "dangerous": True},
    "show_battery": {"path": "/p/app/mc", "value": MODE_COMMANDS["show_battery"], "type": "uint8"},
    "show_version": {"path": "/p/app/mc", "value": MODE_COMMANDS["show_version"], "type": "uint8"},
    "lantern_on": {"path": "/p/app/ltrn/cmd", "value": 1, "type": "uint8"},
    "lantern_off": {"path": "/p/app/ltrn/cmd", "value": 0, "type": "uint8"},
    "stealth_on": {"path": "/u/app/ui/stlm", "value": 1, "type": "uint8"},
    "stealth_off": {"path": "/u/app/ui/stlm", "value": 0, "type": "uint8"},
    "factory_reset": {"path": "/p/app/facr", "value": 1, "type": "uint8", "dangerous": True, "confirm": "RESET"},
}


def registry_payload() -> dict[str, Any]:
    return {
        "paths": [entry.to_dict() for entry in ALL_PATHS],
        "actions": ACTION_COMMANDS,
        "mode_commands": MODE_COMMANDS,
    }


def select_paths(category: str | None = None, status: str | None = None, names: list[str] | None = None) -> list[LoraxPath]:
    if names:
        selected = []
        for name in names:
            entry = PATHS_BY_PATH.get(name) or PATHS_BY_NAME.get(name)
            if entry:
                selected.append(entry)
        return selected
    return [
        entry
        for entry in ALL_PATHS
        if (category is None or entry.category == category)
        and (status is None or entry.status == status)
    ]
