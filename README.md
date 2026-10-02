# Microsoft Voucher Portal

## Firebase setup

1. Create a Firebase project and register a Web app.
2. In Firebase Authentication, enable the Email/Password provider.
3. Create the default Cloud Firestore database (`(default)`) and select a region.
4. Copy `.env.example` to `.env.local` and fill in the Web app config values from Firebase project settings.
5. Publish the rules in `firestore.rules` from the Firestore Rules tab.
6. Restart the Vite server and run `npm run dev`.

The app stores account profile documents in the `users` collection and voucher submissions in `voucherRequests`. Firebase Authentication manages passwords; password values are never written to Firestore. The login form uses email and password, and the employee ID is stored as profile data.

The Firebase Web app config is intended for client apps, but it is not an access-control mechanism. Keep the Firestore rules restrictive and never place an Admin SDK service-account key in this app. These rules let each signed-in user create a profile and create/read only their own voucher requests. Admin approval access needs a separate role-based rule before the Approve Request page is connected.

## Run locally

```sh
npm install
npm run dev
```
