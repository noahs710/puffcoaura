import asyncio
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
from lorax_registry import ALL_PATHS

MAC_ADDRESS = "F0:AD:4E:4B:75:1B"  # Peak Pro (Pretty Peaky)

async def main():
    import websockets
    uri = "ws://127.0.0.1:8421/ws"
    
    print(f"Connecting to WebSocket server at {uri}...")
    try:
        async with websockets.connect(uri, ping_interval=None) as ws:
            print("Connected to WebSocket server.")
            
            # Send connect command to device
            connect_payload = {"cmd": "connect", "mac": MAC_ADDRESS}
            print(f"Sending connect request for MAC: {MAC_ADDRESS}...")
            await ws.send(json.dumps(connect_payload))
            
            # Listen to messages until we get connection status success or error
            connected = False
            while True:
                response = json.loads(await ws.recv())
                resp_type = response.get("type")
                print(f"Server message: {resp_type} - {response.get('message', '')}")
                
                if resp_type == "connection_status":
                    data = response.get("data", {})
                    stage = data.get("stage")
                    if stage == "connected":
                        print("Device connected successfully through server!")
                        connected = True
                        break
                    elif stage == "failed":
                        print("Server failed to connect to device.")
                        break
                elif resp_type == "connected":
                    print("Already/successfully connected!")
                    connected = True
                    break
                elif resp_type == "error":
                    print(f"Error from server: {response.get('message')}")
                    break
                    
            if not connected:
                print("Could not establish connection to the Peak Pro via the server.")
                return

            print("Starting Lorax paths scan...")
            results = []
            
            for idx, entry in enumerate(ALL_PATHS):
                path = entry.path
                if path == "/p/app/facr":
                    print(f"[{idx+1}/{len(ALL_PATHS)}] Skipping factory reset path: {path}")
                    continue
                    
                print(f"[{idx+1}/{len(ALL_PATHS)}] Querying path: {path} ({entry.name})...")
                
                # Send read command
                # Format: {"cmd": "lorax_read", "path": path, "type": type, "size": size}
                read_payload = {
                    "cmd": "lorax_read",
                    "path": path,
                    "type": entry.data_type,
                    "size": entry.size if entry.size and entry.size > 0 else None
                }
                
                success = False
                decoded_val = None
                raw_hex = None
                error_msg = None
                
                for attempt in range(2):
                    try:
                        await ws.send(json.dumps(read_payload))
                        response = json.loads(await ws.recv())
                        
                        if response.get("type") == "lorax_read":
                            data = response.get("data", {})
                            success = True
                            decoded_val = data.get("value")
                            interpretations = data.get("interpretations", {})
                            raw_hex = interpretations.get("raw") or (data.get("raw_bytes") if "raw_bytes" in data else None)
                            error_msg = None
                            break
                        elif response.get("type") == "error":
                            error_msg = response.get("message")
                    except Exception as e:
                        error_msg = str(e)
                        print(f"  Attempt {attempt+1} error: {e}")
                        await asyncio.sleep(0.5)
                        
                results.append({
                    "path": path,
                    "name": entry.name,
                    "registered_type": entry.data_type,
                    "registered_size": entry.size,
                    "success": success,
                    "raw_hex": raw_hex,
                    "decoded": decoded_val,
                    "error": error_msg,
                    "entry": entry.to_dict()
                })
                
                await asyncio.sleep(0.02)
                
            # Write results to JSON
            output_file = Path("c:/PuffcoBLE/tools/lorax_test_results.json")
            with open(output_file, "w", encoding="utf-8") as f:
                json.dump(results, f, indent=2)
            print(f"Results written to {output_file}")
            
    except Exception as e:
        print(f"WS error: {e}")

if __name__ == "__main__":
    asyncio.run(main())
