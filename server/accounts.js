// Brugerkonti: oprettelse, login-opslag, profil og invitationskode.
// Alle brugere ligger i ét dokument ("users") – platformen er tænkt til en familie
// eller en lille kreds, ikke tusindvis af konti, og ét dokument gør skrivninger
// atomiske uden en rigtig database-transaktion.

import { randomBytes, randomUUID } from 'node:crypto';
import { hashPassword, verifyPassword } from './auth.js';

export const MIN_PASSWORD_LENGTH = 8;
export const MAX_USERS = 200;
const MAX_NAME = 40;

export const defaultUsers = () => ({ users: [], inviteCode: null });

// Navnet vises til andre; e-mailen bruges kun til at logge ind og finde hinanden.
export const normalizeEmail = (email) => String(email ?? '').trim().toLowerCase();
const cleanName = (name) => String(name ?? '').replace(/\s+/g, ' ').trim().slice(0, MAX_NAME);

export function validEmail(email) {
  const e = normalizeEmail(email);
  return e.length >= 3 && e.length <= 120 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e);
}

export function newInviteCode() {
  // Læsbar kode uden tegn der forveksles (0/O, 1/I/l).
  const alphabet = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
  const bytes = randomBytes(9);
  let out = '';
  for (let i = 0; i < 9; i++) {
    if (i === 3 || i === 6) out += '-';
    out += alphabet[bytes[i] % alphabet.length];
  }
  return out;
}

// Det andre må se om en bruger. Aldrig adgangskode-hash eller e-mail til fremmede.
export function publicProfile(user, { includeEmail = false } = {}) {
  if (!user) return null;
  return {
    id: user.id,
    name: user.name,
    ...(includeEmail ? { email: user.email } : {}),
    isOwner: Boolean(user.isOwner),
    createdAt: user.createdAt,
  };
}

export function createAccounts(store) {
  const read = () => store.getDoc('users', defaultUsers);
  const write = (fn) => store.updateDoc('users', defaultUsers, fn);

  const findByEmail = (doc, email) => doc.users.find((u) => u.email === normalizeEmail(email)) || null;
  const findById = (doc, id) => doc.users.find((u) => u.id === id) || null;

  return {
    async count() {
      return (await read()).users.length;
    },

    async list() {
      return (await read()).users;
    },

    async byId(id) {
      return findById(await read(), id);
    },

    async byEmail(email) {
      return findByEmail(await read(), email);
    },

    // Den første konto er ejeren og kræver ingen invitationskode: der er endnu
    // ingen data at beskytte, og nogen skal kunne komme i gang.
    async inviteCode() {
      return (await read()).inviteCode;
    },

    async rotateInviteCode() {
      const code = newInviteCode();
      await write((draft) => {
        draft.inviteCode = code;
      });
      return code;
    },

    async signup({ email, password, name, inviteCode }, { requireInvite = true } = {}) {
      const cleanEmail = normalizeEmail(email);
      const displayName = cleanName(name) || cleanEmail.split('@')[0].slice(0, MAX_NAME);
      if (!validEmail(cleanEmail)) throw new SignupError(400, 'Skriv en gyldig e-mailadresse');
      if (String(password ?? '').length < MIN_PASSWORD_LENGTH) throw new SignupError(400, `Adgangskoden skal være mindst ${MIN_PASSWORD_LENGTH} tegn`);

      const passwordHash = await hashPassword(String(password));
      let created = null;
      await write((draft) => {
        if (!Array.isArray(draft.users)) draft.users = [];
        const first = draft.users.length === 0;
        if (!first && requireInvite) {
          const given = String(inviteCode ?? '').trim().toUpperCase();
          if (!draft.inviteCode || given !== draft.inviteCode) throw new SignupError(403, 'Invitationskoden passer ikke. Bed om en ny hos den, der inviterede dig.');
        }
        if (draft.users.length >= MAX_USERS) throw new SignupError(409, 'Der er ikke plads til flere profiler');
        if (draft.users.some((u) => u.email === cleanEmail)) throw new SignupError(409, 'Der findes allerede en profil med den e-mail');
        created = {
          id: randomUUID(),
          email: cleanEmail,
          name: displayName,
          passwordHash,
          isOwner: first,
          createdAt: new Date().toISOString(),
        };
        // Ejeren får en invitationskode med det samme, så der er noget at dele ud af.
        if (first && !draft.inviteCode) draft.inviteCode = newInviteCode();
        draft.users.push(created);
      });
      return created;
    },

    // Returnerer brugeren ved rigtig adgangskode, ellers null. Tager samme tid uanset
    // om e-mailen findes, så man ikke kan aflæse hvilke e-mails der er oprettet.
    async verify(email, password) {
      const user = findByEmail(await read(), email);
      const stored = user?.passwordHash ?? 'scrypt$00$00';
      const ok = await verifyPassword(String(password ?? ''), stored);
      return ok && user ? user : null;
    },

    async rename(id, name) {
      const displayName = cleanName(name);
      if (!displayName) throw new SignupError(400, 'Navnet må ikke være tomt');
      await write((draft) => {
        const user = findById(draft, id);
        if (!user) throw new SignupError(404, 'Profilen findes ikke');
        user.name = displayName;
      });
      return displayName;
    },

    async changePassword(id, currentPassword, newPassword) {
      if (String(newPassword ?? '').length < MIN_PASSWORD_LENGTH) throw new SignupError(400, `Adgangskoden skal være mindst ${MIN_PASSWORD_LENGTH} tegn`);
      const doc = await read();
      const user = findById(doc, id);
      if (!user) throw new SignupError(404, 'Profilen findes ikke');
      if (!(await verifyPassword(String(currentPassword ?? ''), user.passwordHash))) throw new SignupError(401, 'Den nuværende adgangskode er forkert');
      const passwordHash = await hashPassword(String(newPassword));
      await write((draft) => {
        const target = findById(draft, id);
        if (target) target.passwordHash = passwordHash;
      });
      return passwordHash;
    },

    async remove(id) {
      await write((draft) => {
        draft.users = draft.users.filter((u) => u.id !== id);
      });
    },

    // Alle profiler, eventuelt filtreret på navn eller hel e-mail. Alle på platformen
    // er inviteret ind af en, der allerede er her, så listen er ikke hemmelig.
    async browse(query, { exclude = null, limit = 200 } = {}) {
      const q = String(query ?? '').trim().toLowerCase();
      const doc = await read();
      return doc.users
        .filter((u) => u.id !== exclude)
        .filter((u) => !q || u.name.toLowerCase().includes(q) || u.email === q)
        .sort((a, b) => a.name.localeCompare(b.name, 'da'))
        .slice(0, limit)
        .map((u) => publicProfile(u));
    },
  };
}

export class SignupError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}
