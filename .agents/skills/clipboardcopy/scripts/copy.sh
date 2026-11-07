#!/bin/bash
# テキストをMacのクリップボード(pbcopy)にコピーします

if [ $# -eq 0 ]; then
    # 引数がない場合は標準入力から
    LANG=en_US.UTF-8 pbcopy
else
    # 引数がある場合はファイルとして読み込む
    if [ -f "$1" ]; then
        LANG=en_US.UTF-8 pbcopy < "$1"
    else
        echo "❌ エラー: ファイル $1 が見つかりません。" >&2
        exit 1
    fi
fi

if [ $? -eq 0 ]; then
    echo "✅ クリップボードに正常にコピーされました。"
else
    echo "❌ pbcopyの実行に失敗しました。" >&2
    exit 1
fi
