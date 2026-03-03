$env:Path = [System.Environment]::GetEnvironmentVariable("Path","Machine") + ";" + [System.Environment]::GetEnvironmentVariable("Path","User")
Set-Location "C:\Users\minja\OneDrive\Desktop\nigger\openclaw\extensions\pump-trader\dashboard"
npx vite --port 5173
