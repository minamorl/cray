import { Graph } from './graph';

export function toMermaid<S, E>(graph: Graph<S, E>): string {
  const lines = ['graph TD'];

  for (const node of graph.nodes.values()) {
    lines.push(`  ${node.id}[${node.kind}]`);

    for (const edge of node.succ) {
      const label =
        edge.kind === 'ok'
          ? 'ok'
          : edge.kind === 'err'
          ? 'err'
          : edge.kind === 'branch'
          ? 'when'
          : 'otherwise';
      lines.push(`  ${node.id} -->|${label}| ${edge.target}`);
    }
  }

  return lines.join('\n');
}
