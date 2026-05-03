import crypto from "crypto";

export const generateRandomPassword = (): string => {
    const upper = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";
    const lower = "abcdefghijklmnopqrstuvwxyz";
    const numbers = "0123456789";
    const special = "!@#$%^&*";

    const all = upper + lower + numbers + special;

    const getRandomChar = (chars: string) =>
        chars[crypto.randomInt(0, chars.length)];

    const passwordArray = [
        getRandomChar(upper),
        getRandomChar(lower),
        getRandomChar(numbers),
        getRandomChar(special),
    ];

    // Fill remaining (12 total)
    for (let i = passwordArray.length; i < 12; i++) {
        passwordArray.push(getRandomChar(all));
    }

    // Shuffle
    for (let i = passwordArray.length - 1; i > 0; i--) {
        const j = crypto.randomInt(0, i + 1);
        [passwordArray[i], passwordArray[j]] = [
            passwordArray[j],
            passwordArray[i],
        ];
    }

    return passwordArray.join("");
};
