# Firebase Auth Migration Setup

## 1. Firebase Console (one-time, ~10 min)

### Enable Email/Password Auth
- https://console.firebase.google.com → your project
- Build → Authentication → Get started
- Sign-in method → Enable **Email/Password** → Save

### Authorize your Render domain
- Authentication → Settings → Authorized domains
- Add: `aiits.onrender.com`

### Customize reset email template
- Authentication → Templates → Password reset
- From name: "Vibrant Academy"
- Customize action URL: `https://aiits.onrender.com/__/auth/action`

### Get Frontend Config
- Project settings (gear) → Your apps → Add app → Web
- Copy the `firebaseConfig` object
- **Paste it into `frontend/index.html`** (search for `YOUR_FIREBASE_API_KEY`)

### Get Backend Service Account
- Project settings → Service accounts → Generate new private key
- Copy entire JSON → paste as `FIREBASE_SERVICE_ACCOUNT_JSON` in Render dashboard

---

## 2. Render Dashboard — Env Vars

**ADD:**
```
FIREBASE_SERVICE_ACCOUNT_JSON = {"type":"service_account","project_id":"..."}
```

**REMOVE (no longer needed):**
- `EMAIL_USER`
- `EMAIL_PASS`
- `OTP_EXPIRY`

**Keep everything else unchanged.**

---

## 3. npm

```bash
npm install        # installs firebase-admin (already in package.json)
```

Nodemailer has been removed from package.json.

---

## 4. What changed in this project

| File | Change |
|---|---|
| `backend/utils/firebaseAdmin.js` | NEW — Firebase Admin SDK init |
| `backend/models/UserProfile.js` | NEW — replaces User model for auth |
| `backend/middleware/auth.js` | verifyIdToken instead of jwt.verify |
| `backend/routes/auth.js` | /register saves profile; /login /forgot /reset removed |
| `backend/routes/rankings.js` | User → UserProfile |
| `backend/routes/results.js` | User → UserProfile |
| `backend/routes/admin.js` | User → UserProfile, deletes Firebase user on student delete |
| `frontend/index.html` | Firebase SDK, new auth functions, new forgot-password UI |
| `package.json` | firebase-admin added, nodemailer removed |

---

## 5. Forgot Password Flow (new)

1. User clicks "Forgot password" → enters email
2. Frontend calls `sendPasswordResetEmail(auth, email)` — **Firebase sends the email directly from Google's servers**
3. User clicks link in email → Firebase's hosted reset page → sets new password
4. Done. No OTP. No SMTP. No Nodemailer. Works perfectly on Render.

---

## 6. Existing users

Existing MongoDB users cannot log in because they have no Firebase account.
**Options:**
- **Easiest:** Ask users to re-register (show a one-time banner)
- **Migration:** Run a script that calls `admin.auth().createUser()` for each old user and sends them a password reset email via Firebase
