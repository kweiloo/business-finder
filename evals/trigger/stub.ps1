# Stand-in for the real business-finder CLI during the trigger eval.
# Logs its arguments and prints a short canned result, so no Google Maps
# search runs. The log path comes from BF_TRIGGER_LOG, set by run.ts.
$line = (Get-Date -Format o) + "`t" + ($args -join ' ')
if ($env:BF_TRIGGER_LOG) { Add-Content -LiteralPath $env:BF_TRIGGER_LOG -Value $line -Encoding UTF8 }
$cmd = if ($args.Count -gt 0) { [string]$args[0] } else { '' }
switch ($cmd) {
  'doctor' { Write-Output 'Business Finder 0.1.0: ready.'; exit 0 }
  'lists' { Write-Output 'No saved lists yet.'; exit 0 }
  'serve' { Write-Output ([char]0x2713 + ' Business Finder running at http://127.0.0.1:8080'); exit 0 }
  'scrape' {
    Write-Output 'Searching around the requested place.'
    Write-Output '100 places found, 94 with a phone, WhatsApp or email.'
    Write-Output 'saved as list eval0001. Run business-finder serve to see it.'
    exit 0
  }
  default { Write-Output 'Business Finder 0.1.0. Commands: doctor, lists, scrape, add, serve, delete.'; exit 0 }
}
