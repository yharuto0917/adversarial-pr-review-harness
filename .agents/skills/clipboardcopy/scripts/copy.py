import sys
import subprocess
import argparse

import os

def copy_to_clipboard(text):
    # pbcopyプロセスを起動して標準入力にテキストを流し込む
    env = os.environ.copy()
    env['LANG'] = 'en_US.UTF-8'
    process = subprocess.Popen('pbcopy', env=env, stdin=subprocess.PIPE)
    process.communicate(text.encode('utf-8'))
    
    if process.returncode != 0:
        print("❌ pbcopyの実行に失敗しました。", file=sys.stderr)
        sys.exit(1)

def main():
    parser = argparse.ArgumentParser(description="テキストをMacのクリップボード(pbcopy)にコピーします")
    parser.add_argument('file', nargs='?', help='読み込むファイル（指定がない場合は標準入力から読み込みます）')
    args = parser.parse_args()

    try:
        if args.file:
            with open(args.file, 'r', encoding='utf-8') as f:
                text = f.read()
        else:
            text = sys.stdin.read()
        
        copy_to_clipboard(text)
        print("✅ クリップボードに正常にコピーされました。")
    except Exception as e:
        print(f"❌ エラーが発生しました: {e}", file=sys.stderr)
        sys.exit(1)

if __name__ == '__main__':
    main()
