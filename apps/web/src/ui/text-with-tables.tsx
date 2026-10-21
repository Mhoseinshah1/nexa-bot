import { plainTableLines, textSegments } from '../table-text';

/**
 * A hand-written text as the bot will show it (R5C-2 B2): ordinary lines as a `preview-text`
 * block and each `| a | b |` table as a real table, the way a rich message draws it. The
 * bot's own parser decides what is sent; this is only the preview of it.
 */
export function TextWithTables({
  text,
  plain = false,
}: {
  readonly text: string;
  /** The message is not sent as a rich message: a table is drawn as the plain `a | b` lines. */
  readonly plain?: boolean;
}) {
  if (plain) return <pre className="preview-text">{plainTableLines(text)}</pre>;
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
