import asyncio
import struct
import sys
import os

# Insert the vendored package path
VENDORED_SITE = r"C:\PuffcoBLE\.venv-puffco\Lib\site-packages"
sys.path.insert(0, VENDORED_SITE)

from puffcoble import PuffcoBLE

async def main():
    print("Starting diag...")
    try:
        device = PuffcoBLE('Peak', debug=False)
        print("Connecting...")
        await device.connect()
        print("Connected.")
        
        for path in ['/p/bat/cap', '/p/bat/volt', '/p/bat/chg/stat', '/p/app/stat/id']:
            try:
                raw = await device.read_short(path, 0, 16)
                print(f'{path}: raw={raw.hex()}')
                if len(raw) >= 4:
                    fval = struct.unpack('<f', raw[:4])[0]
                    uval = struct.unpack('<I', raw[:4])[0]
                    print(f'  float: {fval}')
                    print(f'  uint32: {uval}')
            except Exception as e:
                print(f'{path} error: {e}')
                
        await device.disconnect()
        print("Done.")
    except Exception as e:
        print('Connection error:', e)

if __name__ == '__main__':
    asyncio.run(main())
