// Handing something to a conversation's chat box from another tab (Changes: review comments; Preview: a screenshot).
//
// handToChat(id, { text, images, send }) keeps it for that conversation and fires the window event 'fv-handto'
// ({ id }). The detail panel switches to the Chat tab on it; the compose box (compose.js) takes what is waiting for
// its conversation with takeHandoff(id), when it mounts and on every 'fv-handto' for its id, and puts the text in
// the box (after what is already typed) and the images with the attachments. `send: true` sends it at once, the way
// the Send button does; otherwise it waits in the box. images: [{ blob, name }] (image/png and the like).
// effort: 'high' (with send) is the least effort the session should run it at: one known to be below it, or not
// known, gets "/effort high" first; one at it or above is left as it is (a Launch from chat.js asks for high).
const waiting = new Map(); // id -> [{ text, images, send, effort }]

export function handToChat(id, item) {
  if (!id || !item) return;
  const list = waiting.get(id) || [];
  list.push({ text: item.text || '', images: item.images || [], send: !!item.send, effort: item.effort || null });
  waiting.set(id, list);
  window.dispatchEvent(new CustomEvent('fv-handto', { detail: { id } }));
}

// everything waiting for this conversation, oldest first; the list is then empty
export function takeHandoff(id) {
  const list = waiting.get(id) || [];
  waiting.delete(id);
  return list;
}
