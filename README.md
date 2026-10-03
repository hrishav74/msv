# Microsoft Voucher Portal

## Firebase setup

1. Create a Firebase project and register a Web app.
2. In Firebase Authentication, enable the Email/Password provider.
3. Create the default Cloud Firestore database (`(default)`) and select a region.
4. Copy `.env.example` to `.env.local` and fill in the Web app config values from Firebase project settings.
5. Publish the rules in `firestore.rules` from the Firestore Rules tab.
6. Restart the Vite server and run `npm run dev`.

The app stores account profile documents in the `users` collection and voucher submissions in `voucherRequests`. New requests receive sequential numeric reference numbers starting at 3072, stored with a Firestore transaction and shared counter. Existing requests remain readable. Users can edit their name, employee ID, and location; the email remains read-only. Password changes reauthenticate with the current password. Profile photos are optional, resized in the browser, and saved only in that browser's local storage; they are not uploaded to Firebase or shared across devices.

The Firebase Web app config is intended for client apps, but it is not an access-control mechanism. Keep the Firestore rules restrictive and never place an Admin SDK service-account key in this app. Publish `firestore.rules` whenever those rules change; profile editing requires the owner-only update rule, and request creation requires an atomic update to the shared reference counter. The rules let each signed-in user create and update only permitted fields in their profile and create/read only their own voucher requests, while manager approval access is role-restricted.

## Run locally

```sh
npm install
npm run dev
```

## Deploy to GitHub Pages

The `main` branch is built and deployed to GitHub Pages by `.github/workflows/deploy.yml`.

1. In the `msv` repository on GitHub, open **Settings → Secrets and variables → Actions → Variables** and add these repository variables using the matching values from your local `.env.local`:
   - `VITE_FIREBASE_API_KEY`
   - `VITE_FIREBASE_AUTH_DOMAIN`
   - `VITE_FIREBASE_PROJECT_ID`
   - `VITE_FIREBASE_STORAGE_BUCKET`
   - `VITE_FIREBASE_MESSAGING_SENDER_ID`
   - `VITE_FIREBASE_APP_ID`
   - `VITE_FIREBASE_DATABASE_ID` (use `(default)` if the app uses the default Firestore database)
2. Open **Settings → Pages** and set the build and deployment source to **GitHub Actions**.
3. In Firebase Authentication, add `hrishav74.github.io` to the authorized domains. Make sure the Firestore rules in `firestore.rules` are published in the Firebase project.
4. Open the repository's **Actions** tab and check the **Deploy to GitHub Pages** workflow. Once it succeeds, the site is available at `https://hrishav74.github.io/msv/`.

Firebase web configuration is included in the built client app, so these repository variables are not secrets. Access control must be enforced by Firebase Authentication and Firestore rules. Do not add `.env.local` or a Firebase Admin SDK service-account key to the repository.
