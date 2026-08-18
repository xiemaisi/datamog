# datamog-gsheet

*Part of the [Datamog](../../../README.md) monorepo.*

Google Sheets loader plugin for Datamog. Populates extensional predicate tables from Google Sheets using the [google-spreadsheet](https://www.npmjs.com/package/google-spreadsheet) library.

## Quick start

Given a Datamog program that declares an extensional predicate:

```prolog
input predicate parent(name: string, child: string).
```

Point it at a Google Sheet with the predicate's like-named input flag (after the program):

```bash
# Public sheet (API key)
GOOGLE_API_KEY=... bun run datamog program.dl --parent https://docs.google.com/spreadsheets/d/SPREADSHEET_ID

# Private sheet (service account)
GOOGLE_SERVICE_ACCOUNT_EMAIL=... GOOGLE_PRIVATE_KEY=... bun run datamog program.dl --parent https://docs.google.com/spreadsheets/d/SPREADSHEET_ID
```

The first row of the sheet must contain headers that match the declared column names (e.g. `name`, `child`).

Cells are coerced the way the [CSV loader](../csv/README.md) coerces them, so the same `?` rule applies: an empty cell is a `null`, which loads only into a column declared with a `?` suffix (`age: integer?`) and is otherwise a hard load error. A non-nullable `string` column is the exception, taking an empty cell as the empty string.

## Authentication

Two methods are supported. If both are set, service account takes precedence.

### API key (public sheets)

For spreadsheets shared as "Anyone with the link can view".

1. Create a Google Cloud project and enable the **Google Sheets API**.
2. Create an API key under **APIs & Services > Credentials**.
3. Set the `GOOGLE_API_KEY` environment variable.

```bash
export GOOGLE_API_KEY=AIza...
```

### Service account (private sheets)

For spreadsheets that are not publicly shared. This is the recommended approach for production use.

1. Create a Google Cloud project and enable the **Google Sheets API**.
2. Create a service account under **IAM & Admin > Service Accounts**.
3. Generate a JSON key for the service account and note the `client_email` and `private_key` fields.
4. **Share the spreadsheet** with the service account's email address (as Viewer or Editor).
5. Set the environment variables:

```bash
export GOOGLE_SERVICE_ACCOUNT_EMAIL=my-service@my-project.iam.gserviceaccount.com
export GOOGLE_PRIVATE_KEY="-----BEGIN PRIVATE KEY-----\n...\n-----END PRIVATE KEY-----\n"
```

## Configuration

Each predicate is mapped to a spreadsheet via the `sheets` option:

```ts
{
  spreadsheetId: "...",  // Google Sheets spreadsheet ID (required)
  range: "Sheet1",       // Sheet/tab name (default: "Sheet1")
}
```

When using the CLI with an input flag, the spreadsheet ID is extracted from the Google Sheets URL automatically. To select a specific tab, there is currently no CLI flag; the default tab `Sheet1` is used.

## Programmatic API

```ts
import { DatamogExecutor } from "datamog-engine";
import { GSheetLoader } from "datamog-gsheet";

const loader = new GSheetLoader({
  auth: { apiKey: process.env.GOOGLE_API_KEY! },
  // or: auth: { serviceAccountEmail: "...", privateKey: "..." },
  sheets: {
    parent: { spreadsheetId: "1BxiMVs0XRA5nFMdKvBdBZjgmUUqptlbs74OgVE2upms" },
    edge: { spreadsheetId: "1abc...", range: "Edges" },
  },
});

const executor = new DatamogExecutor(backend, [loader]);
```
