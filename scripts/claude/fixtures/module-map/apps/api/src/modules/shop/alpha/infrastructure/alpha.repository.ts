import {
  Clock,
  WidgetId as W,
  SomeVeryLongExportedNameNumberOne,
  SomeVeryLongExportedNameNumberTwo,
  SomeVeryLongExportedNameNumberThree,
} from '@nexa/contracts';
export const del = (db: any) =>
  db.delete(
    schema.sprockets,
    // a call long enough that prettier itself keeps the arguments on their own line
    { reason: 'padding to exceed the print width of one hundred characters on one line' },
  );
const m = new Map();
m.delete(key);
