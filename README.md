# Wishpond Churn Forecast

A responsive GitHub Pages dashboard for every Google Sheets tab whose name ends in `Forecast`.

The dashboard includes:

- Month, AM, CSM, risk, brand, and preventable filters.
- Separate Account, AM, and CSM columns.
- AM and CSM dropdowns for reassignments.
- Password-protected AM/CSM updates back to Google Sheets.
- Forecast KPIs, churn reasons, account details, and CSV export.
- Automatic header detection, so inserting rows above the table does not break the dashboard.
- Support for both the older seven-column forecast tabs and the newer twelve-column layout.

## Files

- `index.html` — dashboard structure.
- `styles.css` — responsive styles.
- `app.js` — loading, filtering, display, CSV export, and reassignment saving.
- `Code.gs` — Google Apps Script bridge for reading the forecast tabs and updating AM/CSM assignments.

## One-time Apps Script setup

1. Open the source Google Sheet.
2. Select **Extensions → Apps Script**.
3. In the Apps Script editor, open `Code.gs`.
4. Select all of its existing contents and delete them.
5. Copy all of this repository's `Code.gs` file, including the opening comment, and paste it into the editor.
6. Click **Save project**.
7. In the left sidebar, click **Project Settings** (the gear icon).
8. Scroll to **Script Properties** and click **Add script property**.
9. Enter exactly:
   - Property: `WRITE_SECRET`
   - Value: a strong editing password that you will give only to approved dashboard editors
10. Click **Save script properties**.
11. Click **Deploy → Manage deployments**.
12. Select the existing active web-app deployment and click its pencil icon.
13. In **Version**, choose **New version**.
14. Keep **Execute as: Me** and **Who has access: Anyone**.
15. Click **Deploy** or **Update**.

The existing `/exec` web-app URL should stay the same. If Google creates a different URL, replace the `endpoint` value near the top of `app.js` with the new `/exec` URL.

## Publish the dashboard on GitHub Pages

Upload or replace these four files in the root of the `Wishpond-Churn` repository:

1. `index.html`
2. `styles.css`
3. `app.js`
4. `Code.gs` (kept here as the Apps Script source/reference)

Commit the changes to `main`. GitHub Pages should then publish:

<https://qvintero.github.io/Wishpond-Churn/>

## Using assignment editing

1. Open the dashboard.
2. Use the AM or CSM dropdown in any account row.
3. Change as many assignments as needed.
4. Click **Save assignments**.
5. Enter the same password stored in the `WRITE_SECRET` Script Property.
6. Wait for the “Changes saved” confirmation.

Only names already assigned somewhere in a forecast tab appear in the dropdowns. To add a brand-new AM or CSM, first enter that name in one account in Google Sheets, then refresh the dashboard.

The password is not written into the public GitHub files or saved in browser storage. It remains in the current page's memory until the page is refreshed or closed.

## Sheet rules

- Forecast tab names must end in ` Forecast`, for example `September Forecast`.
- Required headers are `Client Name`, `AM`, `CSM`, `MRR`, and `Brand`.
- The header row can move within the first 20 rows.
- Optional modern columns include `Start date`, `Churn Date`, `Tenure (Months)`, `Risk`, `Main Reason for Churn`, `Preventable?`, and `Comments from CSM`.
- Older `Reason for Churn` and `Status` headers are recognized automatically.

## Security and privacy

This remains a public GitHub Pages dashboard backed by an Apps Script web app accessible to `Anyone`. Anyone with the dashboard or Apps Script URL can read the forecast data. The edit password protects AM/CSM updates, but anyone who learns that password can make those two types of changes.

Use a unique password, do not reuse a Google or company password, and change the `WRITE_SECRET` Script Property if it is shared accidentally. If the forecast itself must be private, use hosting with organization authentication instead of public GitHub Pages.
