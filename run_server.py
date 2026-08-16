"""启动评测框架:后端 API + 前端页面。用法: python run_server.py [port]"""
import sys

import uvicorn

if __name__ == "__main__":
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 8765
    print(f"SWE-bench Pro 最小集评测框架启动中: http://127.0.0.1:{port}")
    uvicorn.run("app.main:app", host="127.0.0.1", port=port, log_level="info")
