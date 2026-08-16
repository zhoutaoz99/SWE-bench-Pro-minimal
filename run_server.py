"""启动评测框架:后端 API + 前端页面。

用法: python run_server.py [port] [--reload]
  --reload  开发模式:代码改动后自动重启(注意:会中断进行中的评测请求)
"""
import sys

import uvicorn

if __name__ == "__main__":
    args = [a for a in sys.argv[1:] if not a.startswith("-")]
    port = int(args[0]) if args else 8765
    reload_ = "--reload" in sys.argv or "-r" in sys.argv
    print(f"SWE-bench Pro 最小集评测框架启动中: http://127.0.0.1:{port}"
          + ("(开发模式,代码改动自动重启)" if reload_ else ""))
    uvicorn.run("app.main:app", host="127.0.0.1", port=port,
                log_level="info", reload=reload_)
