// Følge-relationer. En kant går fra "follower" til "target" og har to tilstande:
//   pending  – anmodningen er sendt og venter på svar
//   accepted – anmodningen er sagt ja til, og følgeren kan se porteføljen
//
// Ingen kan se en andens portefølje uden en accepteret kant. Det er hele
// adgangskontrollen: alt andet i appen spørger canView() først.

export const defaultSocial = () => ({ edges: [] });
export const MAX_EDGES = 5000;

export function createSocial(store) {
  const read = () => store.getDoc('social', defaultSocial);
  const write = (fn) => store.updateDoc('social', defaultSocial, fn);
  const find = (doc, followerId, targetId) => doc.edges.find((e) => e.followerId === followerId && e.targetId === targetId) || null;

  return {
    async edges() {
      return (await read()).edges;
    },

    // Sender en anmodning. Findes den allerede, ændres intet – så et dobbeltklik
    // ikke kan gøre en accepteret følger til en ventende igen.
    async request(followerId, targetId) {
      if (followerId === targetId) throw new SocialError(400, 'Du kan ikke følge dig selv');
      let status = 'pending';
      await write((draft) => {
        if (!Array.isArray(draft.edges)) draft.edges = [];
        const existing = find(draft, followerId, targetId);
        if (existing) {
          status = existing.status;
          return;
        }
        if (draft.edges.length >= MAX_EDGES) throw new SocialError(409, 'Der er ikke plads til flere følgere');
        draft.edges.push({ followerId, targetId, status: 'pending', createdAt: new Date().toISOString() });
      });
      return status;
    },

    async accept(followerId, targetId) {
      await write((draft) => {
        const edge = find(draft, followerId, targetId);
        if (!edge) throw new SocialError(404, 'Anmodningen findes ikke');
        edge.status = 'accepted';
        edge.acceptedAt = new Date().toISOString();
      });
    },

    // Bruges både til at afvise en anmodning, fjerne en følger og holde op med at følge.
    async remove(followerId, targetId) {
      await write((draft) => {
        draft.edges = draft.edges.filter((e) => !(e.followerId === followerId && e.targetId === targetId));
      });
    },

    async removeUser(userId) {
      await write((draft) => {
        draft.edges = draft.edges.filter((e) => e.followerId !== userId && e.targetId !== userId);
      });
    },

    async status(followerId, targetId) {
      if (followerId === targetId) return 'self';
      return find(await read(), followerId, targetId)?.status ?? 'none';
    },

    // Må `viewerId` se `targetId`s portefølje?
    async canView(viewerId, targetId) {
      if (viewerId === targetId) return true;
      return (await this.status(viewerId, targetId)) === 'accepted';
    },

    // Dem jeg følger (accepteret) og dem jeg har sendt anmodning til.
    async following(userId) {
      const doc = await read();
      return doc.edges.filter((e) => e.followerId === userId);
    },

    // Dem der følger mig, og dem der venter på mit svar.
    async followers(userId) {
      const doc = await read();
      return doc.edges.filter((e) => e.targetId === userId);
    },
  };
}

export class SocialError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}
