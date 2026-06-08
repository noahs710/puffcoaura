"""Known and discoverable Puffco Lorax path metadata.

This registry has been cleaned and optimized. It contains only verified paths that
returned valid data on the device, critical write-only paths, and system fallback paths.
Data types and descriptions have been corrected to match the actual integer
representations on the firmware.
"""

from __future__ import annotations

from dataclasses import asdict, dataclass
from typing import Any


PROFILE_RANGE = range(4)
READ_TYPES = {"bytes", "text", "float32", "int16", "uint16", "int32", "uint32", "uint8", "int8", "bool"}
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
                    f"Profile {index} target temperature, stored as Celsius tenths (uint32)",
                    "read_write",
                    "uint32",
                    4,
                    "profile",
                    command="set_profile",
                    notes="UI converts Fahrenheit to Celsius tenths before writing.",
                ),
                LoraxPath(
                    f"{base}/time",
                    f"profile_{index}_duration",
                    f"Profile {index} heat duration, stored as uint32 (scale 200)",
                    "read_write",
                    "uint32",
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
    LoraxPath(
        "/p/sys/hw/mdcd",
        "model_code",
        "Hardware model code",
        "read",
        "uint32",
        4,
        "system",
    ),
    LoraxPath(
        "/p/sys/hw/ser",
        "serial_number",
        "Device serial number",
        "read",
        "text",
        64,
        "system",
    ),
    LoraxPath(
        "/u/sys/name",
        "device_name",
        "User-visible Bluetooth/device name",
        "read",
        "text",
        32,
        "system",
    ),
    LoraxPath(
        "/p/sys/fw/ver",
        "firmware_version",
        "Application firmware revision",
        "read",
        "uint8",
        4,
        "system",
    ),
    LoraxPath(
        "/p/sys/fw/api",
        "api_version",
        "Lorax API version",
        "read",
        "uint32",
        4,
        "system",
    ),
    LoraxPath(
        "/p/sys/fw/bver",
        "bootloader_version",
        "Bootloader revision",
        "read",
        "uint8",
        4,
        "system",
    ),
    LoraxPath(
        "/p/sys/fw/bgit",
        "bootloader_git_hash",
        "Bootloader git hash",
        "read",
        "text",
        64,
        "system",
    ),
    LoraxPath(
        "/p/sys/uptm",
        "uptime",
        "Device uptime in seconds",
        "read",
        "uint32",
        4,
        "system",
    ),
    LoraxPath(
        "/p/sys/time",
        "utc_time",
        "Device UTC clock as Unix seconds",
        "read_write",
        "uint32",
        4,
        "system",
    ),
    LoraxPath(
        "/u/sys/bday",
        "device_birthday",
        "Device birthday/first setup time as Unix seconds",
        "read",
        "uint32",
        4,
        "system",
    ),
    LoraxPath(
        "/p/htr/chmt",
        "chamber_type",
        "Detected chamber type",
        "read",
        "uint8",
        1,
        "heater",
    ),
    LoraxPath(
        "/p/htr/chdt",
        "cable_handshake_detected",
        "Cable/chamber handshake detection counter",
        "read",
        "uint32",
        4,
        "heater",
    ),
    LoraxPath(
        "/p/app/htr/temp",
        "current_temperature",
        "Official app live chamber temperature, Celsius tenths (uint32)",
        "read",
        "uint32",
        4,
        "heater",
        notes="Official Puffco app userHeaterTemp; watch at ~250 ms while dabbing.",
    ),
    LoraxPath(
        "/p/app/htr/tcmd",
        "target_temperature",
        "Official app heater target temperature command, Celsius tenths (uint32)",
        "read",
        "uint32",
        4,
        "heater",
        notes="Official Puffco app userHeaterTempCommand.",
    ),
    LoraxPath(
        "/p/htr/temp",
        "heater_temperature",
        "Lower-level live heater temperature, Celsius tenths (uint32)",
        "read",
        "uint32",
        4,
        "heater",
        notes="Official Puffco app heaterTemp.",
    ),
    LoraxPath(
        "/p/htr/tcmd",
        "heater_target_temperature",
        "Lower-level heater target command, Celsius tenths (uint32)",
        "read",
        "uint32",
        4,
        "heater",
        notes="Official Puffco app heaterTempCommand.",
    ),
    LoraxPath(
        "/p/htr/pwr",
        "heater_power",
        "Heater power telemetry (uint32)",
        "read",
        "uint32",
        4,
        "heater",
    ),
    LoraxPath(
        "/p/htr/res",
        "heater_resistance",
        "Heater resistance telemetry (uint32)",
        "read",
        "uint32",
        4,
        "heater",
    ),
    LoraxPath(
        "/p/htr/vavg",
        "heater_voltage",
        "Heater voltage telemetry (uint32)",
        "read",
        "uint32",
        4,
        "heater",
    ),
    LoraxPath(
        "/p/app/htr/draw",
        "draw_strength_candidate",
        "Candidate dynamic inhale draw-strength sensor",
        "read",
        "float32",
        4,
        "heater",
        "experimental",
    ),
    LoraxPath(
        "/p/app/htr/inh",
        "inhale_strength_candidate",
        "Candidate dynamic inhale sensor",
        "read",
        "float32",
        4,
        "heater",
        "experimental",
    ),
    LoraxPath(
        "/p/app/htr/air",
        "airflow_strength_candidate",
        "Candidate airflow/draw-strength sensor",
        "read",
        "float32",
        4,
        "heater",
        "experimental",
    ),
    LoraxPath(
        "/p/htr/air",
        "heater_airflow_candidate",
        "Lower-level candidate airflow sensor",
        "read",
        "float32",
        4,
        "heater",
        "experimental",
    ),
    LoraxPath(
        "/p/htr/flow",
        "heater_flow_candidate",
        "Lower-level candidate draw/flow sensor",
        "read",
        "float32",
        4,
        "heater",
        "experimental",
    ),
    LoraxPath(
        "/p/bat/chg/stat",
        "battery_charge_state",
        "Battery charging state enum",
        "read",
        "uint8",
        1,
        "battery",
    ),
    LoraxPath(
        "/p/bat/chg/etf",
        "battery_charge_estimated_time_to_full",
        "Estimated seconds/minutes to full charge, signed int32 (-1 if not charging)",
        "read",
        "int32",
        4,
        "battery",
        notes="Official app battChargeEstTimeToFull.",
    ),
    LoraxPath(
        "/p/bat/chg/src",
        "battery_charge_source",
        "Battery charge source enum",
        "read",
        "uint8",
        1,
        "battery",
    ),
    LoraxPath(
        "/p/bat/chg/iout",
        "battery_charge_current",
        "Charging output current, signed int32",
        "read",
        "int32",
        4,
        "battery",
    ),
    LoraxPath(
        "/p/bat/chg/elap",
        "battery_charge_elapsed_time",
        "Charging elapsed time (uint32)",
        "read",
        "uint32",
        4,
        "battery",
    ),
    LoraxPath(
        "/p/bat/soc",
        "battery_soc",
        "Displayed battery state of charge, scale 100 (uint32)",
        "read",
        "uint32",
        4,
        "battery",
        notes="Official Puffco app battSoc; prefer this over /p/bat/cap for UI percent.",
    ),
    LoraxPath(
        "/u/bat/msoc",
        "max_battery_soc",
        "Configured maximum battery state of charge, scale 100 (uint32)",
        "read",
        "uint32",
        4,
        "battery",
    ),
    LoraxPath(
        "/p/bat/cap",
        "battery_capacity",
        "Battery capacity telemetry, raw value (uint32)",
        "read",
        "uint32",
        4,
        "battery",
    ),
    LoraxPath(
        "/p/bat/curr",
        "battery_current",
        "Battery current telemetry, signed int32 milliamperes (negative is discharging)",
        "read",
        "int32",
        4,
        "battery",
    ),
    LoraxPath(
        "/p/bat/volt",
        "battery_voltage",
        "Battery voltage telemetry, millivolts (uint32)",
        "read",
        "uint32",
        4,
        "battery",
    ),
    LoraxPath(
        "/p/bat/temp",
        "battery_temperature",
        "Battery temperature, Celsius tenths (uint32)",
        "read",
        "uint32",
        4,
        "battery",
    ),
    LoraxPath(
        "/u/app/lbws",
        "low_battery_warning_soc",
        "Low-battery warning threshold/state of charge, scale 100 (uint32)",
        "read",
        "uint32",
        4,
        "battery",
    ),
    LoraxPath(
        "/p/app/stat/id",
        "operating_state",
        "Main app operating state enum",
        "read",
        "uint8",
        1,
        "state",
    ),
    LoraxPath(
        "/p/app/stat/elap",
        "state_elapsed_time",
        "Elapsed time in current operating state, milliseconds (uint32)",
        "read",
        "uint32",
        4,
        "state",
    ),
    LoraxPath(
        "/p/app/stat/tott",
        "state_total_time",
        "Total time for current operating state, signed int32",
        "read",
        "int32",
        4,
        "state",
    ),
    LoraxPath(
        "/p/app/info/dpd",
        "dabs_per_day",
        "Estimated dabs per day, scale 100 (uint32)",
        "read",
        "uint32",
        4,
        "usage",
    ),
    LoraxPath(
        "/p/app/info/drem",
        "dabs_remaining",
        "Estimated dabs remaining before charge, scale 100 (uint32)",
        "read",
        "uint32",
        4,
        "usage",
    ),
    LoraxPath(
        "/p/app/odom/0/nc",
        "total_heat_cycles",
        "Total completed heat cycles (uint32)",
        "read",
        "uint32",
        4,
        "usage",
        notes="Official Puffco app totalHeatCycles.",
    ),
    LoraxPath(
        "/p/app/odom/0/tm",
        "total_heat_cycle_time",
        "Total heat-cycle runtime, in seconds (uint32)",
        "read",
        "uint32",
        4,
        "usage",
        notes="Official Puffco app totalHeatCycleTime/dabTotalTime.",
    ),
    LoraxPath(
        "/p/app/odom/1/nc",
        "trip_heat_cycles",
        "Trip heat-cycle count (uint32)",
        "read",
        "uint32",
        4,
        "usage",
    ),
    LoraxPath(
        "/p/app/odom/1/tm",
        "trip_heat_cycle_time",
        "Trip heat-cycle runtime, in seconds (uint32)",
        "read",
        "uint32",
        4,
        "usage",
    ),
    LoraxPath(
        "/p/app/mc",
        "mode_command",
        "Mode command byte mailbox",
        "write",
        "uint8",
        1,
        "command",
        command="mode_command",
        notes="Values are ModeCommands enum.",
    ),
    LoraxPath(
        "/p/app/ltrn/cmd",
        "lantern_command",
        "Lantern on/off command and status",
        "read_write",
        "uint8",
        1,
        "lighting",
        command="lantern",
    ),
    LoraxPath(
        "/p/app/ltrn/remt",
        "lantern_remaining_time",
        "Lantern remaining time, milliseconds (uint32)",
        "read",
        "uint32",
        4,
        "lighting",
    ),
    LoraxPath(
        "/p/app/ltrn/time",
        "lantern_time",
        "Lantern configured time, milliseconds (uint32)",
        "read",
        "uint32",
        4,
        "lighting",
    ),
    LoraxPath(
        "/u/app/ui/lbrt",
        "led_brightness",
        "LED brightness for base/mid/glass/logo channels",
        "read_write",
        "bytes",
        4,
        "lighting",
        command="brightness",
    ),
    LoraxPath(
        "/u/app/ui/stlm",
        "stealth_mode",
        "Stealth mode flag",
        "read_write",
        "uint8",
        1,
        "lighting",
        command="stealth",
    ),
    LoraxPath(
        "/p/logv/flt/end",
        "fault_log_end",
        "Fault log end index",
        "read",
        "uint32",
        4,
        "logs",
    ),
    LoraxPath(
        "/p/logv/flt/begn",
        "fault_log_begin",
        "Fault log begin index",
        "read",
        "uint32",
        4,
        "logs",
    ),
    LoraxPath(
        "/p/logv/flt/entr",
        "fault_log_entry",
        "Fault log entry payload",
        "read",
        "bytes",
        125,
        "logs",
    ),
    LoraxPath(
        "/p/app/bt/ufca",
        "unexpected_ble_fault_absolute_count",
        "Unexpected BLE fault absolute count",
        "read",
        "uint32",
        4,
        "logs",
    ),
    LoraxPath(
        "/p/app/bt/ufcc",
        "unexpected_ble_fault_credit_count",
        "Unexpected BLE fault credit count",
        "read",
        "uint32",
        4,
        "logs",
    ),
    LoraxPath(
        "/p/app/facr",
        "factory_reset",
        "Factory reset trigger",
        "write",
        "uint8",
        1,
        "power",
        command="factory_reset",
        dangerous=True,
    ),
    LoraxPath(
        "/p/app/hcs",
        "current_profile",
        "Selected heat profile index",
        "read_write",
        "int8",
        1,
        "profile",
        command="select_profile",
    ),
    LoraxPath(
        "/u/app/rdym/hc",
        "ready_mode_profile",
        "Ready-mode heat profile selection (uint32)",
        "read_write",
        "uint32",
        4,
        "profile",
    ),
    LoraxPath(
        "/p/app/thc/name",
        "active_profile_name",
        "Selected profile name",
        "read",
        "text",
        32,
        "profile",
    ),
    LoraxPath(
        "/p/app/thc/temp",
        "active_profile_temperature",
        "Selected profile target temperature, Celsius tenths (uint32)",
        "read",
        "uint32",
        4,
        "profile",
    ),
    LoraxPath(
        "/p/app/thc/time",
        "active_profile_duration",
        "Selected profile heat duration, stored as uint32 (scale 200)",
        "read",
        "uint32",
        4,
        "profile",
    ),
    LoraxPath(
        "/p/app/thc/btmp",
        "active_profile_boost_temperature_delta",
        "Selected profile boost temperature delta, Celsius tenths (uint32)",
        "read_write",
        "uint32",
        4,
        "profile",
        command="set_boost_options",
    ),
    LoraxPath(
        "/p/app/thc/btim",
        "active_profile_boost_time_delta",
        "Selected profile boost time delta, stored as uint32 (scale 200)",
        "read_write",
        "uint32",
        4,
        "profile",
        command="set_boost_options",
    ),
    LoraxPath(
        "/p/app/thc/colr",
        "active_profile_color_animation",
        "Selected profile color/animation CBOR payload",
        "read",
        "bytes",
        125,
        "profile",
    ),
    *_profile_paths(),
)


ALL_PATHS: tuple[LoraxPath, ...] = KNOWN_PATHS
PATHS_BY_PATH: dict[str, LoraxPath] = {entry.path: entry for entry in ALL_PATHS}
PATHS_BY_NAME: dict[str, LoraxPath] = {entry.name: entry for entry in ALL_PATHS}


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
    "idle": {"path": "/p/app/mc", "value": MODE_COMMANDS["idle"], "type": "uint8"},
    "temp_selection_begin": {"path": "/p/app/mc", "value": MODE_COMMANDS["temp_selection_begin"], "type": "uint8"},
    "temp_selection_end": {"path": "/p/app/mc", "value": MODE_COMMANDS["temp_selection_end"], "type": "uint8"},
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


def select_paths(
    category: str | None = None,
    status: str | None = None,
    names: list[str] | None = None,
) -> list[LoraxPath]:
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
