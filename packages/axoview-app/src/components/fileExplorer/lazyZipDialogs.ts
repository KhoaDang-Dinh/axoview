import { lazy } from 'react';

// The ZIP import/export dialogs (and the zip code behind them) are opened
// rarely, so they stay out of the editor's boot-critical JS
// (scripts/check-bundle-budget.js). Every caller must use these, never a
// static import of the dialog modules: a single static import anywhere pulls
// the code back into the boot bundle. Render them inside <Suspense>.
export const ImportDialog = lazy(() =>
  import('./ImportDialog').then(({ ImportDialog }) => ({ default: ImportDialog }))
);

export const ExportProjectZipDialog = lazy(() =>
  import('./ExportProjectZipDialog').then(({ ExportProjectZipDialog }) => ({
    default: ExportProjectZipDialog
  }))
);
