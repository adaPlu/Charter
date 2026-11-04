// charter ask "<request>": the only command that needs a model (design doc, section 8.4).
// @charter/intent is loaded lazily here and nowhere else, so every other command
// runs on a machine with no model and no API key. check-layers.mjs enforces this.

export async function ask(request: string): Promise<void> {
  const intent = await import("@charter/intent");
  void intent;
  throw new Error(`charter ask is planned for milestone 7 (request: ${request})`);
}
