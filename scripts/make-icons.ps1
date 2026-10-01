# 图标生成：从 build/icon-256.png 母版高质量缩放出全部尺寸并重建 icon.ico（PNG 帧）
# 取代旧的 desktop/render-icon.cjs（其 SVG 字符串替换缩放会产出"图案贴角"的坏帧）
param([string]$Root = "$PSScriptRoot\..")
Add-Type -AssemblyName System.Drawing

$master = Join-Path $Root "build\icon-256.png"
if (-not (Test-Path $master)) { Write-Error "缺少母版 $master"; exit 1 }
$sizes = @(256, 128, 64, 48, 32, 16)

# 经内存流加载母版，避免 FromFile 锁定源文件导致无法回写同名 PNG
$masterBytes = [IO.File]::ReadAllBytes($master)
$src = [System.Drawing.Bitmap]::FromStream([IO.MemoryStream]::new($masterBytes))
foreach ($s in $sizes) {
  $out = New-Object System.Drawing.Bitmap($s, $s)
  $g = [System.Drawing.Graphics]::FromImage($out)
  $g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
  $g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::HighQuality
  $g.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
  $g.DrawImage($src, 0, 0, $s, $s)
  $g.Dispose()
  $out.Save((Join-Path $Root "build\icon-$s.png"), [System.Drawing.Imaging.ImageFormat]::Png)
  $out.Dispose()
}
$src.Dispose()

# ICO 容器：每帧为 PNG 数据（Windows Vista+ 外壳可解码）
# 逗号包裹避免 PowerShell 管线把 byte[] 展平成单个字节
$pngs = @()
foreach ($s in $sizes) { $pngs += , [IO.File]::ReadAllBytes((Join-Path $Root "build\icon-$s.png")) }
$header = [byte[]]::new(6); $header[2] = 1; $header[3] = 0
$header[4] = [byte]($sizes.Count -band 0xFF); $header[5] = [byte](($sizes.Count -shr 8) -band 0xFF)
$dir = [byte[]]::new(16 * $sizes.Count)
$offset = 6 + 16 * $sizes.Count
for ($i = 0; $i -lt $sizes.Count; $i++) {
  $s = $sizes[$i]; $o = 16 * $i
  $dir[$o] = [byte]($s -band 0xFF); if ($s -ge 256) { $dir[$o] = 0 }
  $dir[$o + 1] = $dir[$o]
  $dir[$o + 4] = 1; $dir[$o + 5] = 0              # 类型: 图标
  $dir[$o + 6] = 32; $dir[$o + 7] = 0             # 位深
  $len = $pngs[$i].Length
  for ($k = 0; $k -lt 4; $k++) { $dir[$o + 8 + $k] = [byte](($len -shr (8 * $k)) -band 0xFF) }
  for ($k = 0; $k -lt 4; $k++) { $dir[$o + 12 + $k] = [byte](($offset -shr (8 * $k)) -band 0xFF) }
  $offset += $len
}
$outIco = [byte[]]::new($offset)
[Array]::Copy($header, $outIco, 6)
[Array]::Copy($dir, 0, $outIco, 6, $dir.Length)
$p = $offset - 6 - $dir.Length
$pos = 6 + $dir.Length
for ($i = 0; $i -lt $sizes.Count; $i++) {
  [Array]::Copy($pngs[$i], 0, $outIco, $pos, $pngs[$i].Length); $pos += $pngs[$i].Length
}
[IO.File]::WriteAllBytes((Join-Path $Root "build\icon.ico"), $outIco)
Write-Output ("icon.ico 重建完成: " + $outIco.Length + " bytes, 帧尺寸 " + ($sizes -join "/"))
