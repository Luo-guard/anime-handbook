import argparse
import logging
import os
from pathlib import Path

# Existing business logic uses local dates. Online deployment uses Beijing time.
os.environ["TZ"] = "Asia/Shanghai"
import time
if hasattr(time, "tzset"):
    time.tzset()

from .http import OnlineServer


def main():
    parser = argparse.ArgumentParser(description="动漫手账线上服务（不启动本机 Kazumi/坚果云同步）")
    parser.add_argument("--data-dir", type=Path, default=Path(os.environ.get("HANDBOOK_ONLINE_DATA", ".online-data")))
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=43128)
    parser.add_argument("--origin", default=os.environ.get("HANDBOOK_ORIGIN", ""))
    parser.add_argument("--development", action="store_true")
    args = parser.parse_args()
    origin = args.origin or (f"http://127.0.0.1:{args.port}" if args.development else "")
    logging.basicConfig(level=logging.INFO)
    server = OnlineServer((args.host, args.port), args.data_dir, origin, args.development)
    print(f"动漫手账线上服务：{origin}；数据目录：{server.runtime.root}")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()


if __name__ == "__main__":
    main()
