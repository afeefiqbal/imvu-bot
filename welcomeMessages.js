/**
 * Welcome Message Generator with Room Name
 */

const welcomeTemplates = [
    (n, r) => `Hey ${n} 👋 welcome to ${r}!`,
    (n, r) => `Yo ${n}! Welcome to ${r} 😎`,
    (n, r) => `${n} just joined ${r} 🎉`,
    (n, r) => `Welcome ${n} 🔥 enjoy your time in ${r}`,
    (n, r) => `Hey ${n}! Good to see you in ${r} 👀`,
    (n, r) => `${n} entered ${r} like a boss 😏`,
    (n, r) => `Welcome aboard ${n} 🚀 to ${r}`,
    (n, r) => `${n} just pulled up to ${r} 🚗`,
    (n, r) => `Hey ${n} 👋 ${r} just got better`,
    (n, r) => `${n} joined ${r}… let's go 🔥`,
    (n, r) => `Welcome ${n}, vibes in ${r} just upgraded ✨`,
    (n, r) => `${n} has arrived in ${r} 🎯`,
    (n, r) => `Hey ${n}, welcome to the chaos of ${r} 😈`,
    (n, r) => `${n} just stepped into ${r} 👣`,
    (n, r) => `Welcome ${n} 😄 enjoy ${r}`,
    (n, r) => `${n} entered ${r}… interesting 👀`,
    (n, r) => `Hey ${n}, welcome to ${r} 🤝`,
    (n, r) => `${n} joined ${r} like a legend 🏆`,
    (n, r) => `Welcome ${n}, let's vibe in ${r} 🎶`,
    (n, r) => `${n} just made an entrance in ${r} 🚪`,
];

const random = (arr) => arr[Math.floor(Math.random() * arr.length)];

export const getWelcomeMessage = (name, roomName = 'the room') =>
    random(welcomeTemplates)(name || 'there', roomName);
