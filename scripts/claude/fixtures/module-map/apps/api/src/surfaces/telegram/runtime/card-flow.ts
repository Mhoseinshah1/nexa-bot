export function cardScreen(rt: unknown, command: string) {
  return { rt, command };
}
export async function cardBack(rt: unknown) {
  return cardScreen(rt, 'back');
}
