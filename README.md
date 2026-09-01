# Wishpond September Churn Forecast

A responsive, read-only GitHub Pages dashboard for the `September Forecast` tab in the Wishpond churn workbook.

## What was wrong

The previous repository file was an exported Google Doc, not executable HTML. Its source contained escaped tags such as `&lt;html&gt;`, so GitHub Pages displayed the code instead of running the dashboard.

The original guide and attached backend also expected a different sheet layout: seven columns with month-divider rows. The real `September Forecast` tab has a title row, headers on row 2, a section row on row 3, and 12 fields per client.

## Files

- `index.html` - accessible dashboard structure.
- `styles.css` - responsive dashboard styles.
- `app.js` - Google Sheets loading, normalization, filters, insights, table details, and CSV export.
- `Code.gs` - recommended read-only Apps Script backend for the actual 12-column schema.

## Deploy the frontend

GitHub Pages already targets this repository. Once these files are on `main`, the dashboard is available at:

<https://qvintero.github.io/Wishpond-Churn/>

GitHub Pages may take a minute or two to publish a new commit.

## Update the Apps Script backend

The current Apps Script deployment is compatible enough for the dashboard to load, but it serializes dates one day early and returns an empty duplicate September group. Replacing it with `Code.gs` fixes both issues.

1. Open the source Google Sheet.
2. Select **Extensions → Apps Script**.
3. Replace the editor contents with `Code.gs` and save.
4. Select **Deploy → Manage deployments**.
5. Edit the web-app deployment, choose **New version**, and select **Update**.
6. Keep **Execute as: Me** and **Who has access: Anyone** if the dashboard must remain on public GitHub Pages.

The existing `/exec` URL stays the same, so no frontend change is needed.

## Important privacy note

GitHub Pages is public, and an Apps Script web app accessible to `Anyone` makes the returned client data public to anyone who has or discovers its URL. This dashboard is intentionally read-only because a write secret embedded in a public web page is not a secret and would let visitors modify the spreadsheet.

If the client names and CSM comments must stay internal, host the dashboard behind authentication instead of public GitHub Pages (for example, as an Apps Script HTML web app restricted to your Google Workspace organization).
