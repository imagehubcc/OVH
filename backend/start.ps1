# 后端启动脚本
# 使用方法: .\start.ps1

# 检查虚拟环境是否存在
if (-not (Test-Path "venv")) {
    Write-Host "正在创建虚拟环境..." -ForegroundColor Yellow
    python -m venv venv
}

# 激活虚拟环境
Write-Host "正在激活虚拟环境..." -ForegroundColor Yellow
& .\venv\Scripts\Activate.ps1

# 检查依赖是否已安装
if (-not (Test-Path "venv\Scripts\pip.exe")) {
    Write-Host "正在安装依赖..." -ForegroundColor Yellow
    pip install -r requirements.txt
}

# 检查 .env 文件是否存在
if (-not (Test-Path ".env")) {
    Write-Host "警告: .env 文件不存在，正在从 env_example.txt 复制..." -ForegroundColor Yellow
    if (Test-Path "env_example.txt") {
        Copy-Item env_example.txt .env
        Write-Host "请编辑 .env 文件配置 API_SECRET_KEY 等参数" -ForegroundColor Red
    }
}

# 启动应用
Write-Host "正在启动后端服务..." -ForegroundColor Green
python app.py

