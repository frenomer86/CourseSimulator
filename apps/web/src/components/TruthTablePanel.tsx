import { useMemo } from 'react';
import { truthTable, type Circuit } from '@cslab/engine-digital-logic';

export function TruthTablePanel({ circuit }: { circuit: Circuit }) {
  const table = useMemo(() => truthTable(circuit), [circuit]);
  if (table.inputs.length === 0) {
    return <p className="text-sm text-ink-soft">Add a switch to see the truth table build itself.</p>;
  }
  if (table.inputs.length > 5) {
    return <p className="text-sm text-ink-soft">Truth tables are shown for up to 5 inputs.</p>;
  }
  return (
    <div className="overflow-x-auto">
      <table className="font-mono text-sm border-collapse">
        <thead>
          <tr>
            {table.inputs.map((l) => (
              <th key={`i-${l}`} className="border border-line px-2.5 py-1 bg-bench font-medium">
                {l}
              </th>
            ))}
            {table.outputs.map((l) => (
              <th key={`o-${l}`} className="border border-line px-2.5 py-1 bg-high-soft font-medium text-high">
                {l}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {table.rows.map((r, i) => (
            <tr key={i}>
              {r.inputs.map((b, k) => (
                <td key={k} className="border border-line px-2.5 py-0.5 text-center text-ink-soft">
                  {b}
                </td>
              ))}
              {r.outputs.map((b, k) => (
                <td
                  key={k}
                  className={`border border-line px-2.5 py-0.5 text-center ${
                    b === 1 ? 'text-high font-medium' : b === undefined ? 'text-gold-deep' : ''
                  }`}
                >
                  {b === undefined ? '?' : b}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
