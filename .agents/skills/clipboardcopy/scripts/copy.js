const { execSync } = require('child_process');
const fs = require('fs');

try {
  let text = '';
  const args = process.argv.slice(2);
  
  if (args.length > 0) {
    const filePath = args[0];
    if (fs.existsSync(filePath)) {
      text = fs.readFileSync(filePath, 'utf-8');
    } else {
      console.error(`❌ エラー: ファイル ${filePath} が見つかりません。`);
      process.exit(1);
    }
  } else {
    // 標準入力からの読み込み
    text = fs.readFileSync(0, 'utf-8');
  }

  // pbcopyプロセスを起動してテキストを流し込む
  execSync('pbcopy', { input: text, env: { ...process.env, LANG: 'en_US.UTF-8' } });
  console.log("✅ クリップボードに正常にコピーされました。");
} catch (error) {
  console.error(`❌ エラーが発生しました: ${error.message}`);
  process.exit(1);
}
