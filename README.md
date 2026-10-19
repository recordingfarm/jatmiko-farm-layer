# Jatmiko Farm Layer — Frontend (GitHub Pages)

Aplikasi recording kandang layer. Frontend statis (HTML/CSS/JS) yang memanggil backend Google Apps Script lewat `fetch()`.

```
index.html          ← halaman utama (SPA)
css/style.css       ← tampilan
js/config.js        ← ⚠️ isi GAS_URL di sini (satu-satunya file yang diedit)
js/app.js           ← logika aplikasi
img/                ← logo, favicon
.nojekyll
```

## Konfigurasi
Buka `js/config.js`, ganti `ISI_URL_EXEC_DARI_APPS_SCRIPT` dengan URL Web App (akhiran `/exec`).

## Update
```
git add .
git commit -m "Deskripsi perubahan"
git push
```
Tunggu 1-2 menit lalu buka situs dengan Ctrl+Shift+R.
