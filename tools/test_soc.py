import asyncio
import struct
import sys
import cbor2
VENDORED_SITE = r'C:\PuffcoBLE\.venv-puffco\Lib\site-packages'
sys.path.insert(0, VENDORED_SITE)
from puffcoble import PuffcoBLE
from puffcoble.utils.rgbtApi2 import decode_puffco_json

async def main():
    device = PuffcoBLE('Peak', debug=False)
    try:
        await device.connect()
        path = '/p/app/thc/colr'
        try:
            raw = await device.read_bytes_all(path)
            print(f'{path} raw hex: {raw.hex()}')
            decoded = cbor2.loads(raw)
            print(f'{path} decoded CBOR: {decoded}')
            print(f'{path} decoded JSON: {decode_puffco_json(decoded)}')
        except Exception as e:
            print(f'Failed to read {path}: {e}')
        
        # Read from u/app/hc/0/colr as well
        path_hc = '/u/app/hc/0/colr'
        try:
            raw = await device.read_bytes_all(path_hc)
            print(f'{path_hc} raw hex: {raw.hex()}')
            decoded = cbor2.loads(raw)
            print(f'{path_hc} decoded CBOR: {decoded}')
            print(f'{path_hc} decoded JSON: {decode_puffco_json(decoded)}')
        except Exception as e:
            print(f'Failed to read {path_hc}: {e}')
            
        await device.disconnect()
    except Exception as e:
        print('Error:', e)

if __name__ == '__main__':
    asyncio.run(main())
