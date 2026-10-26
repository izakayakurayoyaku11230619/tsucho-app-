#!/bin/sh
# AI Office をワンコマンドで起動する(初回は仮想環境の作成と部品の取得もする)
cd "$(dirname "$0")/server" || exit 1
command -v python3 >/dev/null 2>&1 || { echo "Python 3 が入っていません。https://www.python.org/downloads/ から入れてください。"; exit 1; }
[ -d .venv ] || python3 -m venv .venv
. .venv/bin/activate
pip install -q -r requirements.txt
echo "http://localhost:8000/ をブラウザで開いてください(止めるときは Ctrl+C)"
exec python -m uvicorn main:app --port 8000
