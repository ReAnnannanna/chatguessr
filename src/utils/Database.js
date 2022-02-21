'use strict';

const SQLite = require('better-sqlite3');
const { randomUUID } = require('crypto');

/** @typedef {import('../types').LatLng} LatLng */

function timestamp() {
    return Math.floor(Date.now() / 1000);
}

// NEVER modify existing migrations, ONLY add new ones.
/** @type {((db: SQLite.Database) => void)[]} */
const migrations = [
    function initialSetup(db) {
        const usersTable = db.prepare(`CREATE TABLE users (
            -- Twitch user ID
            id TEXT PRIMARY KEY NOT NULL,
            -- Twitch display name
            username TEXT NOT NULL,
            flag TEXT DEFAULT NULL,
            previous_guess TEXT DEFAULT NULL,
            last_location TEXT DEFAULT NULL,
            reset_at INT DEFAULT 0
        )`);

        const gamesTable = db.prepare(`CREATE TABLE games (
            -- GeoGuessr game token
            id TEXT PRIMARY KEY NOT NULL,
            map TEXT NOT NULL,
            map_name TEXT NOT NULL,
            -- JSON bounds: {min: LatLng, max: LatLng}
            -- for the scoring formula
            map_bounds TEXT NOT NULL,
            -- boolean 0 or 1
            forbid_moving INT NOT NULL,
            -- boolean 0 or 1
            forbid_panning INT NOT NULL,
            -- boolean 0 or 1
            forbid_zooming INT NOT NULL,
            -- in seconds
            time_limit INT DEFAULT NULL,
            created_at INT NOT NULL
        )`);

        const roundsTable = db.prepare(`CREATE TABLE rounds (
            -- UUID
            id TEXT PRIMARY KEY NOT NULL,
            game_id TEXT NOT NULL,
            -- JSON coordinates {lat,lng,heading,pitch}
            location TEXT NOT NULL,
            -- Country code of the location
            country TEXT DEFAULT NULL,
            created_at INT NOT NULL,

            FOREIGN KEY(game_id) REFERENCES games(id)
        )`);

        const guessesTable = db.prepare(`CREATE TABLE guesses (
            -- UUID
            id TEXT PRIMARY KEY NOT NULL,
            user_id TEXT NOT NULL,
            round_id TEXT NOT NULL,
            -- User color at the time the guess was made.
            color TEXT DEFAULT NULL,
            -- User flag at the time the guess was made.
            flag TEXT DEFAULT NULL,
            -- JSON coordinates {lat,lng}
            location TEXT NOT NULL,
            -- Country code where the guess was placed
            country TEXT DEFAULT NULL,
            streak INT DEFAULT 0,
            -- Distance (in metres?), slightly inaccurate
            distance INT NOT NULL,
            score INT NOT NULL,
            created_at INT NOT NULL,

            FOREIGN KEY(user_id) REFERENCES users(id),
            FOREIGN KEY(round_id) REFERENCES rounds(id)
        )`);

        usersTable.run();
        gamesTable.run();
        roundsTable.run();
        guessesTable.run();

        // These are all deriveable … maybe add them later if it is useful
        /*
        ALTER TABLE users ADD COLUMN streak INT DEFAULT 0;
        ALTER TABLE users ADD COLUMN best_streak INT DEFAULT 0;
        ALTER TABLE users ADD COLUMN correct_guesses INT DEFAULT 0;
        ALTER TABLE users ADD COLUMN nb_guesses INT DEFAULT 0;
        ALTER TABLE users ADD COLUMN perfects INT DEFAULT 0;
        ALTER TABLE users ADD COLUMN victories INT DEFAULT 0;
        */
    },
    function createSearchIndices(db) {
        db.prepare(`CREATE INDEX guess_user_id ON guesses(user_id)`).run();
        db.prepare(`CREATE INDEX guess_round_id ON guesses(round_id)`).run();
        db.prepare(`CREATE INDEX round_game_id ON rounds(game_id)`).run();
    },
    function createStreaks(db) {
        db.prepare(`CREATE TABLE streaks (
            id TEXT PRIMARY KEY NOT NULL,
            user_id TEXT NOT NULL,
            last_round_id TEXT NOT NULL,
            count INT NOT NULL DEFAULT 1,
            created_at INT NOT NULL,
            updated_at INT NOT NULL,

            FOREIGN KEY(user_id) REFERENCES users(id),
            FOREIGN KEY(last_round_id) REFERENCES rounds(id)
        )`).run();

        db.prepare(`ALTER TABLE users ADD COLUMN current_streak_id TEXT DEFAULT NULL`).run();
    },
    function createGameWinners(db) {
        // TODO the final LEFT JOIN needs a way to include the guessed_at
        // this query is based on https://stackoverflow.com/a/7745635/591962
        // could be possible to use windowing functions on the game_scores query too, partitioning by game_id and then selecting only
        // those where rank() = 1.
        db.prepare(`
            CREATE VIEW game_winners (id, user_id, score) AS
            -- Only count completed games (with at least 5 rounds), else there is no winner yet
            WITH completed_games AS (
                SELECT games.id
                FROM games, rounds
                WHERE rounds.game_id = games.id
                GROUP BY games.id
                HAVING COUNT(rounds.id) >= 5
            ),
            -- Prepare all users' total scores in each game
            game_scores AS (
                SELECT guesses.user_id, completed_games.id AS game_id, SUM(guesses.score) AS score, MAX(guesses.created_at) AS guessed_at
                FROM completed_games
                LEFT JOIN rounds ON rounds.game_id = completed_games.id
                LEFT JOIN guesses ON guesses.round_id = rounds.id
                GROUP BY guesses.user_id, completed_games.id
            )
            SELECT completed_games.id, top_scores.user_id, top_scores.score
            FROM completed_games
            -- Match the highest total score for each game
            -- This can return multiple records if the top score was a tie: it means we just end up all of them as winners, which seems fair.
            LEFT JOIN (
                SELECT user_id, game_id, MAX(score) AS score
                FROM game_scores
                GROUP BY game_id
            ) top_scores ON completed_games.id = top_scores.game_id
        `).run();
    }
];

class Database {
    /** @type {SQLite.Database} */
    #db;

    /**
     * @param {string} file
     */
    constructor(file) {
        this.#db = new SQLite(file);

        this.#migrate();
    }

    #migrateUp() {
        const version = this.#db.pragma('user_version', { simple: true });
        if (version < migrations.length) {
            const up = this.#db.transaction(() => {
                migrations[version](this.#db);
                this.#db.pragma(`user_version=${version + 1}`);
            });
            up();

            return true;
        }
        return false;
    }

    #migrate() {
        let moreMigrations = true;
        while (moreMigrations) {
            moreMigrations = this.#migrateUp();
        }
    }

    /**
     * 
     * @param {import('../types').Seed} seed 
     */
    createGame(seed) {
        const insertGame = this.#db.prepare(`
            INSERT INTO games(id, map, map_name, map_bounds, forbid_moving, forbid_panning, forbid_zooming, time_limit, created_at)
            VALUES (:id, :map, :mapName, :bounds, :forbidMoving, :forbidPanning, :forbidZooming, :timeLimit, :createdAt)
        `);

        insertGame.run({
            id: seed.token,
            map: seed.map,
            mapName: seed.mapName,
            bounds: JSON.stringify(seed.bounds),
            forbidMoving: seed.forbidMoving ? 1 : 0,
            forbidPanning: seed.forbidRotating ? 1 : 0,
            forbidZooming: seed.forbidZooming ? 1 : 0,
            timeLimit: seed.timeLimit,
            createdAt: timestamp(),
        });
    }

    /**
     * 
     * @param {string} gameId 
     * @returns {string}
     */
    getCurrentRound(gameId) {
        const findRoundId = this.#db.prepare(`
            SELECT id
            FROM rounds
            WHERE game_id = ?
            ORDER BY created_at DESC
            LIMIT 1
        `).pluck(true);

        return findRoundId.get(gameId);
    }

    /**
     * 
     * @param {string} gameId 
     * @param {import('../types').GameRound} round 
     */
    createRound(gameId, round) {
        const insertRound = this.#db.prepare(`
            INSERT INTO rounds(id, game_id, location, created_at)
            VALUES (:id, :gameId, :location, :createdAt)
        `);

        const id = randomUUID();

        insertRound.run({
            id,
            gameId,
            location: JSON.stringify({
                lat: round.lat,
                lng: round.lng,
                panoId: round.panoId,
                heading: round.heading,
                pitch: round.pitch,
            }),
            createdAt: timestamp(),
        });

        return id;
    }

    /**
     * 
     * @param {string} roundId 
     * @param {string} country 
     */
    setRoundCountry(roundId, country) {
        const stmt = this.#db.prepare(`UPDATE rounds SET country = :country WHERE id = :id`);
        stmt.run({
            id: roundId,
            country,
        });
    }

    /**
     * 
     * @param {string} roundId
     * @param {string} userId 
     * @param {{ color: string, flag: string, location: LatLng, country: string | null, streak: number, distance: number, score: number }} guess 
     */
    createGuess(roundId, userId, guess) {
        const id = randomUUID();
        const insertGuess = this.#db.prepare(`
            INSERT INTO guesses(id, round_id, user_id, color, flag, location, country, streak, distance, score, created_at)
            VALUES (:id, :roundId, :userId, :color, :flag, :location, :country, :streak, :distance, :score, :createdAt)
        `);

        insertGuess.run({
            id,
            roundId,
            userId,
            color: guess.color,
            flag: guess.flag,
            location: JSON.stringify(guess.location),
            country: guess.country,
            streak: guess.streak,
            distance: guess.distance,
            score: guess.score,
            createdAt: timestamp(),
        });

        return id;
    }

    /**
     * @param {string} roundId
     * @param {string} userId 
     */
    getUserGuess(roundId, userId) {
        const stmt = this.#db.prepare('SELECT id, color, flag, location, country, streak, distance, score FROM guesses WHERE round_id = ? AND user_id = ?');
        /** @type {{ id: string, color: string, flag: string, location: string, country: string | null, streak: number, distance: number, score: number } | undefined} */
        const row = stmt.get(roundId, userId);
        if (!row) {
            return;
        }
    
        return {
            ...row,
            /** @type {LatLng} */
            location: JSON.parse(row.location),
        };
    }

    /**
     * @param {string} guessId
     * @param {{ color: string, flag: string, location: LatLng, country: string | null, streak: number, distance: number, score: number }} guess 
     */
    updateGuess(guessId, guess) {
        const updateGuess = this.#db.prepare(`
            UPDATE guesses
            SET color = :color, flag = :flag, location = :location, country = :country, streak = :streak, distance = :distance, score = :score
            WHERE id = :id
        `);

        updateGuess.run({
            id: guessId,
            color: guess.color,
            flag: guess.flag,
            location: JSON.stringify(guess.location),
            country: guess.country,
            streak: guess.streak,
            distance: guess.distance,
            score: guess.score,
            // probably not useful but maybe?
            // updatedAt: timestamp(),
        });
    }

    /**
     * 
     * @param {string} guessId 
     * @param {string} country 
     * @param {number} streak
     */
    setGuessCountry(guessId, country, streak) {
        const updateGuess = this.#db.prepare(`
            UPDATE guesses
            SET country = :country, streak = :streak
            WHERE id = :id
        `)

        updateGuess.run({
            id: guessId,
            country,
            streak,
        });
    }

    /**
     * 
     * @param {string} userId 
     * @returns {{ id: string, count: number, lastLocation: LatLng } | undefined}
     */
    getUserStreak(userId) {
        const stmt = this.#db.prepare(`
            SELECT streaks.id, streaks.count, rounds.location
            FROM users, streaks, rounds
            WHERE users.id = ?
              AND streaks.id = users.current_streak_id
              AND rounds.id = streaks.last_round_id
        `);

        /** @type {{ id: string, count: number, location: string } | undefined} */
        const row = stmt.get(userId);
        return row ? {
            id: row.id,
            count: row.count,
            lastLocation: JSON.parse(row.location),
        } : undefined;
    }

    /**
     * 
     * @param {string} userId 
     * @param {string} roundId
     */
    addUserStreak(userId, roundId) {
        const streak = this.getUserStreak(userId);

        if (!streak) {
            const id = randomUUID();
            this.#db.prepare(`
                INSERT INTO streaks(id, user_id, last_round_id, created_at, updated_at)
                VALUES (:id, :userId, :roundId, :createdAt, :createdAt)
            `).run({
                id,
                userId,
                roundId,
                createdAt: timestamp(),
            });
            this.#db.prepare(`UPDATE users SET current_streak_id = :streakId WHERE id = :userId`).run({
                userId,
                streakId: id,
            });
        } else {
            this.#db.prepare(`
                UPDATE streaks
                SET count = count + 1,
                    last_round_id = :roundId,
                    updated_at = :updatedAt
                WHERE id = :id
            `).run({
                id: streak.id,
                roundId,
                updatedAt: timestamp(),
            })
        }
    }

    /**
     * 
     * @param {string} userId 
     */
    resetUserStreak(userId) {
        this.#db.prepare('UPDATE users SET current_streak_id = NULL WHERE id = ?').run(userId);
    }

    /**
     * Get all the participants for a round, sorted by time. No scores included.
     * 
     * @param {string} roundId 
     */
    getRoundParticipants(roundId) {
        const stmt = this.#db.prepare(`
            SELECT
                guesses.id,
                users.username,
                guesses.color,
                guesses.flag
            FROM guesses, users
            WHERE round_id = ? AND users.id = guesses.user_id
            ORDER BY created_at ASC
        `)

        /** @type {{ id: string, username: string, color: string, flag: string }[]} */
        const records = stmt.all(roundId);
        
        return records;
    }

    /**
     * Get all the guesses for a round, sorted from closest distance to farthest away.
     * 
     * @param {string} roundId 
     */
    getRoundScores(roundId) {
        const stmt = this.#db.prepare(`
            SELECT
              guesses.id,
              users.username,
              guesses.color,
              guesses.flag,
              guesses.location,
              guesses.streak,
              guesses.distance,
              guesses.score
            FROM guesses, users
            WHERE round_id = ? AND users.id = guesses.user_id
            ORDER BY distance ASC
        `)

        /** @type {{ id: string, username: string, color: string, flag: string, location: string, streak: number, distance: number, score: number }[]} */
        const records = stmt.all(roundId);

        return records.map((record) => ({
            ...record,
            user: record.username,
            /** @type {LatLng} */
            position: JSON.parse(record.location),
            modified: false,
        }));
    }

    /**
     * 
     * @param {string} gameId 
     */
    getGameScores(gameId) {
        // We need to pick the last guess's streak value OR calculate them on the fly. Our streak tracking table is not suitable for
        // checking the current streak at a previous point. The only option atm is to use this subquery I think, hopefully the
        // performance is not too bad.
        const stmt = this.#db.prepare(`
            SELECT
                users.username,
                guesses.color,
                users.flag,
                (
                    SELECT streak
                    FROM guesses ig, rounds ir
                    WHERE ir.game_id = rounds.game_id
                      AND ig.round_id = ir.id
                      AND ig.user_id = users.id
                    ORDER BY ig.created_at DESC
                    LIMIT 1
                ) AS streak,
                COUNT(guesses.id) AS rounds,
                SUM(guesses.distance) AS distance,
                SUM(guesses.score) AS score
            FROM rounds, guesses, users
            WHERE rounds.game_id = ?
              AND guesses.round_id = rounds.id
              AND users.id = guesses.user_id
            GROUP BY guesses.user_id
            ORDER BY score DESC
        `)
        /** @type {{ username: string, color: string, flag: string, streak: number, rounds: number, distance: number, score: number }[]} */
        const records = stmt.all(gameId);

        return records.map((record) => ({
            ...record,
            user: record.username,
        }));
    }

    /**
     * 
     * @param {Record<string, any>} record 
     * @returns {{ id: string, username: string, flag: string|null, previousGuess: LatLng, lastLocation: LatLng, resetAt: number }}
     */
    #parseUser(record) {
        return {
            id: record.id,
            username: record.username,
            flag: record.flag,
            previousGuess: record.previous_guess ? JSON.parse(record.previous_guess) : null,
            lastLocation: record.last_location ? JSON.parse(record.last_location) : null,
            resetAt: record.reset_at * 1000,
        }
    }

    /**
     * 
     * @param {string} id 
     */
    getUser(id) {
        const user = this.#db.prepare('SELECT id, username, flag, previous_guess, last_location, reset_at FROM users WHERE id = ?').get(id);

        return user ? this.#parseUser(user) : undefined;
    }

    /**
     * 
     * @param {string} id 
     * @param {string} username
     */
    getOrCreateUser(id, username) {
        const stmt = this.#db.prepare(`
            INSERT INTO users(id, username)
            VALUES (:id, :username)
            ON CONFLICT (id) DO
                UPDATE SET username = :username
            RETURNING *
        `);

        const user = stmt.get({ id, username });

        return user ? this.#parseUser(user) : undefined;
    }

    /**
     * 
     * @param {string} userId
     * @param {string} username
     * @param {import('./sharedStore').LegacyUser} storeUser 
     */
    migrateUser(userId, username, storeUser) {
        const migrate = this.#db.prepare(`
            INSERT INTO users(id, username, flag, previous_guess, last_location)
            VALUES (:id, :username, :flag, :previousGuess, :lastLocation)
        `);

        migrate.run({
            id: userId,
            username,
            flag: storeUser.flag,
            previousGuess: storeUser.previousGuess ? JSON.stringify(storeUser.previousGuess) : null,
            lastLocation: storeUser.lastLocation ? JSON.stringify(storeUser.lastLocation) : null,
        });

        return this.getUser(userId);
    }

    /**
     * 
     * @param {string} userId 
     * @param {string} flag 
     */
    setUserFlag(userId, flag) {
        this.#db.prepare(`UPDATE users SET flag = :flag WHERE id = :id`).run({
            id: userId,
            flag,
        })
    }

    /**
     * 
     * @param {string} userId 
     * @param {LatLng} lastLocation 
     */
    setUserLastLocation(userId, lastLocation) {
        this.#db.prepare(`UPDATE users SET last_location = :lastLocation WHERE id = :id`).run({
            id: userId,
            lastLocation: JSON.stringify(lastLocation),
        })
    }

    /**
     * 
     * @param {string} userId 
     */
    getUserStats(userId) {
        const stmt = this.#db.prepare(`
            SELECT
                username,
                flag,
                COALESCE(current_streak.count, 0) AS current_streak,
                COALESCE((SELECT MAX(count) FROM streaks WHERE user_id = :id AND updated_at > users.reset_at), 0) AS best_streak,
                (SELECT COUNT(*) FROM guesses WHERE user_id = :id AND created_at > users.reset_at) AS total_guesses,
                (SELECT COUNT(*) FROM guesses WHERE user_id = :id AND streak > 0 AND created_at > users.reset_at) AS correct_guesses,
                (SELECT COUNT(*) FROM guesses WHERE user_id = :id AND score = 5000 AND created_at > users.reset_at) AS perfects,
                (SELECT AVG(score) FROM guesses WHERE user_id = users.id AND created_at > users.reset_at) AS average,
                (SELECT COUNT(*) FROM game_winners WHERE user_id = users.id) AS victories
            FROM users
            LEFT JOIN streaks current_streak ON current_streak.id = users.current_streak_id
            WHERE users.id = :id
        `);

        /** @type {{ username: string, flag: string, current_streak: number, best_streak: number, total_guesses: number, correct_guesses: number, perfects: number, average: number, victories: number } | undefined} */
        const record = stmt.get({ id: userId });
        return record ? {
            username: record.username,
            flag: record.flag,
            streak: record.current_streak,
            bestStreak: record.best_streak,
            nbGuesses: record.total_guesses,
            correctGuesses: record.correct_guesses,
            meanScore: record.average,
            perfects: record.perfects,
            victories: record.victories,
        } : undefined;
    }

    getGlobalStats() {
        const streakQuery = this.#db.prepare(`
            SELECT users.id, users.username, MAX(streaks.count) AS streak
            FROM users, streaks
            WHERE streaks.user_id = users.id
              AND streaks.created_at > users.reset_at
            GROUP BY users.id
            ORDER BY streak DESC
        `);
        const victoriesQuery = this.#db.prepare(`
            SELECT users.id, users.username, COUNT(*) AS victories
            FROM game_winners
            LEFT JOIN users ON users.id = game_winners.user_id
            GROUP BY users.id
            ORDER BY victories DESC
        `);
        const perfectQuery = this.#db.prepare(`
            SELECT users.id, users.username, COUNT(guesses.id) AS perfects
            FROM users
            LEFT JOIN guesses ON guesses.user_id = users.id AND guesses.created_at > users.reset_at
            WHERE guesses.score = 5000
            GROUP BY users.id
            ORDER BY perfects DESC
        `);

        /** @type {{ id: string, username: string, streak: number } | undefined} */
        const bestStreak = streakQuery.get();
        /** @type {{ id: string, username: string, victories: number } | undefined} */
        const mostVictories = victoriesQuery.get();
        /** @type {{ id: string, username: string, perfects: number } | undefined} */
        const mostPerfects = perfectQuery.get();

        return {
            streak: bestStreak,
            victories: mostVictories,
            perfects: mostPerfects,
        }
    }

    /**
     * 
     * @param {string} userId 
     */
    resetUserStats(userId) {
        this.#db.prepare(`UPDATE users SET current_streak_id = NULL, reset_at = :resetAt WHERE id = :id`).run({
            id: userId,
            resetAt: timestamp(),
        });
    }
}

module.exports = Database;
