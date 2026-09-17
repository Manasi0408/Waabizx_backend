/**
 * Builds frontend and copies into backend/build for unified deploy on app.waabizx.com
 * Usage: node scripts/prepare-waabizx-deploy.js
 */
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const root = path.join(__dirname, '..', '..');
const frontendDir = path.join(root, 'frontend', 'aisensy');
const backendDir = path.join(root, 'backend');
const buildSrc = path.join(frontendDir, 'build');
const buildDest = path.join(backendDir, 'build');

function rimraf(dir) {
  if (!fs.existsSync(dir)) return;
  fs.rmSync(dir, { recursive: true, force: true });
}

function copyDir(src, dest) {
  fs.mkdirSync(dest, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const from = path.join(src, entry.name);
    const to = path.join(dest, entry.name);
    if (entry.isDirectory()) copyDir(from, to);
    else fs.copyFileSync(from, to);
  }
}

console.log('Building frontend (production, same-origin API)...');
execSync('npm run build', { cwd: frontendDir, stdio: 'inherit' });

if (!fs.existsSync(path.join(buildSrc, 'index.html'))) {
  console.error('Frontend build missing index.html');
  process.exit(1);
}

console.log('Copying frontend build → backend/build ...');
rimraf(buildDest);
copyDir(buildSrc, buildDest);

console.log('');
console.log('Deploy ready. Upload the entire backend/ folder to Hostinger Node.js for app.waabizx.com');
console.log('Then SSH: cd backend && npm install --production && pm2 start server.js --name waabizx');
console.log('Verify: curl https://app.waabizx.com/api/health');
