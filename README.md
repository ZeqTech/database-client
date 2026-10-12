# Database Client

VS Code extension to manage any number of database connections, browse tables and run SQL.

- **Databases:** PostgreSQL, MySQL/MariaDB, SQLite
- **Connections:** unlimited; configs in global state, passwords in VS Code SecretStorage
- **Explorer:** Activity Bar → Database Client → connection → schema/database → table/view → columns
- **Table data:** click a table for a paged grid (sort, filter, export CSV)
- **Queries:** right-click connection/table → New Query. `Ctrl+Enter` runs the selection or the statement at the cursor, `Ctrl+Shift+Enter` runs the whole file. Status bar shows/changes the editor's connection.

SQLite uses sql.js (wasm): the file is loaded in memory and rewritten after any statement that may modify it.

## Develop

```bash
npm install
npm run build      # then F5 ("Run Extension")
npm run package    # produces a .vsix
```
