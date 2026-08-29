# Cloudinary setup (question images, option images, ad images)

All image storage — question images, option images, and ad images — now
uploads to Cloudinary instead of being embedded as base64 in the database.
Base64-in-DB was the thing bloating both Mongo documents and DynamoDB items;
Cloudinary URLs are a few bytes each instead of megabytes.

## 1. Create a free Cloudinary account
https://cloudinary.com/users/register/free — the free tier (25 GB storage,
25 GB bandwidth/month) is comfortably enough for this app.

## 2. Get your credentials
Dashboard → you'll see a **Cloud name**, **API Key**, and **API Secret**
right on the landing page, plus a ready-to-copy `CLOUDINARY_URL` string in
the form:
```
cloudinary://<api_key>:<api_secret>@<cloud_name>
```

## 3. Add to Render env vars
Set **one** of these (not both):
- `CLOUDINARY_URL` — paste the string from step 2 as-is, **or**
- `CLOUDINARY_CLOUD_NAME` + `CLOUDINARY_API_KEY` + `CLOUDINARY_API_SECRET` separately

## 4. Redeploy
`npm install` picks up the new `cloudinary` dependency automatically on
Render's next build.

## What changed in code
- `backend/utils/cloudinary.js` — new file, wraps the Cloudinary SDK.
- `backend/routes/admin.js`:
  - `POST/PUT /api/admin/tests` — every `questionImage` and option
    `imageData` that arrives as a base64 data-URI gets uploaded to
    Cloudinary first; only the resulting URL is saved to DynamoDB.
  - `POST /api/admin/ad-images` — the uploaded file goes straight to
    Cloudinary (`uploadBuffer`); `AdImage.imageData` now stores the
    Cloudinary URL instead of a base64 string (same field, same type —
    just a URL in it now).

## Important: existing data is untouched
Tests/questions/ad-images created **before** this change still have their
original base64 image data in the database — nothing is migrated
retroactively. They'll keep working exactly as before (the app renders
`imageData`/`questionImage` as an `<img src="...">` either way, and both a
base64 data-URI and an `https://res.cloudinary.com/...` URL work fine as an
`src`). Only **new** uploads and **edited-and-resaved** questions go through
Cloudinary from now on. If you want to bulk-migrate old base64 images too,
that's a separate one-off script — say the word if you want it written.

## Fallback behavior
If Cloudinary isn't configured yet, question/option image uploads silently
keep working as base64 (with a console warning) so you're not blocked — but
ad-image upload will fail outright with a clear error, since that path was
specifically the one adding the most storage weight and is meant to require
Cloudinary going forward.
