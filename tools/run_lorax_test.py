import asyncio
import sys
import struct
from pathlib import Path
import json

# Insert site-packages and tools directories into sys.path
sys.path.insert(0, r"C:\PuffcoBLE\.venv-puffco\Lib\site-packages")
sys.path.insert(0, str(Path(__file__).parent))

from puffcoble import PuffcoBLE
from lorax_registry import ALL_PATHS

MAC_ADDRESSES = ["F0:AD:4E:4B:75:1B"]  # Peak Pro (Pretty Peaky)

def decode_bytes(raw: bytes, data_type: str):
    if not raw:
        return None
    try:
        if data_type == "text":
            return raw.decode("utf-8", errors="ignore").rstrip("\x00")
        if data_type == "bool":
            return struct.unpack("<?", raw[:1])[0]
        if data_type == "uint8":
            return struct.unpack("<B", raw[:1])[0]
        if data_type == "int8":
            return struct.unpack("<b", raw[:1])[0]
        if data_type == "uint16":
            return struct.unpack("<H", raw[:2])[0]
        if data_type == "int16":
            return struct.unpack("<h", raw[:2])[0]
        if data_type == "uint32":
            return struct.unpack("<I", raw[:4])[0]
        if data_type == "int32":
            return struct.unpack("<i", raw[:4])[0]
        if data_type == "float32":
            return struct.unpack("<f", raw[:4])[0]
        if data_type == "bytes":
            return raw.hex()
    except Exception as e:
        return f"decode_err: {e}"
    return raw.hex()

async def get_connected_device(active_mac=None):
    macs = [active_mac] if active_mac else MAC_ADDRESSES
    if not active_mac:
        macs = MAC_ADDRESSES
        
    for mac in macs:
        for attempt in range(1, 6):
            print(f"Connecting to {mac} (attempt {attempt}/5)...")
            try:
                # Ensure stdout uses UTF-8 to prevent charmap encoding errors
                try:
                    sys.stdout.reconfigure(encoding='utf-8')
                except Exception:
                    pass
                # Use a larger timeout of 25 seconds for Windows BLE handshake
                dev = PuffcoBLE(device_mac=mac, debug=False)
                await asyncio.wait_for(dev.connect(), timeout=25)
                print(f"Connected to {mac}!")
                return dev, mac
            except Exception as e:
                print(f"Connection attempt {attempt} failed: {e}")
                try:
                    await dev.disconnect()
                except Exception:
                    pass
                await asyncio.sleep(2.0)
    return None, None

async def test_all_paths():
    device, active_mac = await get_connected_device()
    if not device:
        print("Could not connect to the Peak Pro device.")
        return

    results = []
    
    try:
        for idx, entry in enumerate(ALL_PATHS):
            path = entry.path
            if path == "/p/app/facr":
                print(f"[{idx+1}/{len(ALL_PATHS)}] Skipping factory reset path: {path}")
                continue

            print(f"[{idx+1}/{len(ALL_PATHS)}] Reading {path} ({entry.name})...")
            
            size = entry.size if entry.size and entry.size > 0 else 4
            if entry.data_type == "text":
                size = 64
            elif entry.data_type == "bytes":
                size = max(size, 32)
            
            success = False
            raw_val = None
            decoded_val = None
            error_msg = None
            
            # Retry loop
            for attempt in range(3):
                # Ensure device is connected
                if not device or not device.client or not device.client.is_connected:
                    print("Device disconnected. Reconnecting...")
                    if device:
                        try:
                            await device.disconnect()
                        except Exception:
                            pass
                    device, active_mac = await get_connected_device(active_mac)
                    if not device:
                        print("Reconnection failed. Waiting 5s before retry...")
                        await asyncio.sleep(5.0)
                        device, active_mac = await get_connected_device(active_mac)
                        if not device:
                            error_msg = "Device disconnected and reconnection failed"
                            break

                try:
                    raw_val = await device.read_short(path, 0, size)
                    success = True
                    decoded_val = decode_bytes(raw_val, entry.data_type)
                    error_msg = None
                    break # Success!
                except Exception as e:
                    error_msg = str(e)
                    print(f"  Attempt {attempt+1} failed: {e}")
                    await asyncio.sleep(1.0)
            
            results.append({
                "path": path,
                "name": entry.name,
                "registered_type": entry.data_type,
                "registered_size": entry.size,
                "success": success,
                "raw_hex": raw_val.hex() if raw_val else None,
                "decoded": decoded_val,
                "error": error_msg,
                "entry": entry.to_dict()
            })
            
            await asyncio.sleep(0.05)

    finally:
        print("Disconnecting...")
        if device:
            try:
                await device.disconnect()
            except Exception as e:
                print(f"Disconnect error: {e}")

    output_file = Path("c:/PuffcoBLE/tools/lorax_test_results.json")
    with open(output_file, "w", encoding="utf-8") as f:
        json.dump(results, f, indent=2)
        
    print(f"Results written to {output_file}")

if __name__ == "__main__":
    asyncio.run(test_all_paths())
