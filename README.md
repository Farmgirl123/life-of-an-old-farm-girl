# Life of an Old Farm Girl (S3 version)

Features:
- Uploads to **Amazon S3** (photos, videos, sponsors)
- YouTube link support
- Delete items (also removes S3 objects)
- Admin login (session-based)
- Analytics (page views, uploads, video interactions, monthly trends)
- Contact form email via SMTP

## Setup

```bash
npm install
```

### Environment variables

```
NODE_ENV=development
SESSION_SECRET=change_me

# Admin
ADMIN_USERNAME=admin
ADMIN_PASSWORD_PLAIN=farmgirl123
# or ADMIN_PASSWORD_HASH=<bcrypt hash>

# AWS
AWS_REGION=us-east-1
S3_BUCKET=your-bucket-name
S3_PUBLIC_URL_BASE=https://your-cloudfront-domain   # recommended

AWS_ACCESS_KEY_ID=...
AWS_SECRET_ACCESS_KEY=...

# SMTP (optional for contact form)
SMTP_HOST=smtp.gmail.com
SMTP_PORT=465
SMTP_USER=you@gmail.com
SMTP_PASS=your_app_password
SMTP_FROM="Life of an Old Farm Girl" <you@gmail.com>
CONTACT_TO=you@gmail.com
```

### Run

```bash
npm start
# http://localhost:3000
# Login at /login.html -> /admin.html
```

### Notes
- For production, set `NODE_ENV=production`, a strong `SESSION_SECRET`, and configure S3 + email envs.
- Prefer CloudFront with Origin Access Control and keep your S3 bucket private.
- Replace `public/assets/logo.png` with your real logo.
