import { textSegments } from '../table-text';

/**
 * A hand-written text as the bot will show it (R5C-2 B2): ordinary lines as a `preview-text`
 * block and each `| a | b |` table as a real table, the way a rich message draws it. The
 * bot's own parser decides what is sent; this is only the preview of it.
 */
export function TextWithTables({ text }: { readonly text: string }) {
  return (
    <>
      {textSegments(text).map((segment, index) =>
        segment.kind === 'text' ? (
          <pre className="preview-text" key={index}>
            {segment.text}
          </pre>
        ) : (
          <table className="preview-table" key={index}>
            <thead>
              <tr>
                {segment.header.map((cell, column) => (
                  <th key={column}>{cell}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {segment.rows.map((row, rowIndex) => (
                <tr key={rowIndex}>
                  {row.map((cell, column) => (
                    <td key={column}>{cell}</td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        ),
      )}
    </>
  );
}
