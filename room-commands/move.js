/**
 * Build IMVU seat assignment chat line for the bot.
 * @param {{ botUserId: string, seatNumber: number, seatFurniId: number }} p
 */
export function buildSeatAssignmentMessage({ botUserId, seatNumber, seatFurniId }) {
    const userId = String(botUserId || '').trim();
    const version = String(process.env.IMVU_WS_SEAT_ASSIGNMENT_VERSION || '3').trim() || '3';
    const seat = Number(seatNumber);
    const furni = Number.isFinite(Number(seatFurniId)) ? Number(seatFurniId) : 0;
    if (!/^\d+$/.test(userId) || !Number.isFinite(seat) || seat <= 0) return null;
    return `*msg SeatAssignment ${version} ${userId} ${seat} ${furni}`;
}

/**
 * @param {unknown} participant
 */
export function seatFromParticipant(participant) {
    if (!participant || typeof participant !== 'object') return null;
    const seatNumber = Number(participant.seat_number);
    if (!Number.isFinite(seatNumber) || seatNumber <= 0) return null;
    const seatFurniId = Number(participant.seat_furni_id);
    return {
        seatNumber,
        seatFurniId: Number.isFinite(seatFurniId) ? seatFurniId : 0,
    };
}
