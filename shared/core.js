/**
 * Shared Core Logic for Kindle Sync
 * Used by both Chrome Extension and Node.js Script
 */

// Minimal HTML entity decoder for common entities seen in RSS feeds
const decodeHtmlEntities = (str) => {
    if (!str || typeof str !== 'string') return str;

    const named = {
        '&amp;': '&',
        '&quot;': '"',
        '&#39;': '\'',
        '&apos;': '\'',
        '&lt;': '<',
        '&gt;': '>'
    };

    return str
        .replace(/&(?:amp|quot|#39|apos|lt|gt);/g, (m) => named[m] || m)
        .replace(/&#(\d+);/g, (_, code) => {
            const num = parseInt(code, 10);
            return Number.isNaN(num) ? _ : String.fromCharCode(num);
        })
        .replace(/&#x([0-9a-fA-F]+);/g, (_, code) => {
            const num = parseInt(code, 16);
            return Number.isNaN(num) ? _ : String.fromCharCode(num);
        });
};

export const Utils = {
    tokenSortRatio: (str1, str2) => {
        if (!str1 || !str2) return 0;

        const s1 = str1.toLowerCase().replace(/[^\w\s]/g, '').split(/\s+/).sort().join(" ");
        const s2 = str2.toLowerCase().replace(/[^\w\s]/g, '').split(/\s+/).sort().join(" ");

        if (s1 === s2) return 100;

        const lev = Utils.levenshtein(s1, s2);
        const maxLen = Math.max(s1.length, s2.length);

        return Math.floor((1 - lev / maxLen) * 100);
    },

    levenshtein: (a, b) => {
        if (a.length === 0) return b.length;
        if (b.length === 0) return a.length;

        const matrix = [];
        for (let i = 0; i <= b.length; i++) matrix[i] = [i];
        for (let j = 0; j <= a.length; j++) matrix[0][j] = j;

        for (let i = 1; i <= b.length; i++) {
            for (let j = 1; j <= a.length; j++) {
                if (b.charAt(i - 1) === a.charAt(j - 1)) {
                    matrix[i][j] = matrix[i - 1][j - 1];
                } else {
                    matrix[i][j] = Math.min(
                        matrix[i - 1][j - 1] + 1,
                        Math.min(
                            matrix[i][j - 1] + 1,
                            matrix[i - 1][j] + 1
                        )
                    );
                }
            }
        }

        return matrix[b.length][a.length];
    },

    parseRSS: (xmlText) => {
        const entries = [];
        const itemRegex = /<item>([\s\S]*?)<\/item>/g;
        let itemMatch;

        while ((itemMatch = itemRegex.exec(xmlText)) !== null) {
            const itemContent = itemMatch[1];

            const getTag = (tag) => {
                const tagRegex = new RegExp(`<${tag}.*?>([\\s\\S]*?)<\/${tag}>`);
                const match = tagRegex.exec(itemContent);
                if (!match) return null;

                const raw = match[1]
                    .replace(/<!\[CDATA\[(.*?)\]\]>/g, '$1')
                    .trim();

                return decodeHtmlEntities(raw);
            };

            entries.push({
                title: getTag("title"),
                author_name: getTag("author_name"),
                isbn: getTag("isbn"),
                isbn13: getTag("isbn13"),
                user_rating: getTag("user_rating"),
                user_read_at: getTag("user_read_at"),
                user_date_added: getTag("user_date_added"),
                book_id: getTag("book_id")
            });
        }

        return entries;
    }
};

export class SyncEngine {
    constructor({ hcToken, rssUrl, isDryRun = false, limit = 20, onLog = () => {} }) {
        this.hcToken = hcToken;
        this.rssUrl = rssUrl;
        this.isDryRun = isDryRun;
        this.limit = limit;
        this.onLog = onLog;
        this.hcEndpoint = "https://api.hardcover.app/v1/graphql";

        this.results = {
            newBooks: 0,
            updatedBooks: 0,
            added: [],
            updated: [],
            errors: []
        };
    }

    log(msg, type = 'info') {
        this.onLog(msg, type);

        if (type === 'error') console.error(msg);
        else console.log(msg);
    }

    getShelfRssUrl(shelf) {
        try {
            const url = new URL(this.rssUrl);
            url.searchParams.set('shelf', shelf);
            return url.toString();
        } catch (_) {
            const separator = this.rssUrl.includes('?') ? '&' : '?';
            return `${this.rssUrl}${separator}shelf=${encodeURIComponent(shelf)}`;
        }
    }

    normalizeIsbn(value) {
        if (!value) return null;
        const normalized = String(value).replace(/[^0-9Xx]/g, '').toUpperCase();
        return normalized || null;
    }

    validRating(value) {
        const parsedRating = Number.parseFloat(value);

        return (
            Number.isFinite(parsedRating) &&
            parsedRating >= 0.5 &&
            parsedRating <= 5 &&
            Number.isInteger(parsedRating * 2)
        ) ? parsedRating : null;
    }

    async fetchShelf(shelf, label) {
        const url = this.getShelfRssUrl(shelf);
        this.log(`Fetching Goodreads ${label} shelf...`, 'info');

        const res = await fetch(url);
        if (!res.ok) {
            throw new Error(`Goodreads ${label} RSS returned HTTP ${res.status}`);
        }

        const text = await res.text();
        const entries = Utils.parseRSS(text);

        this.log(`Found ${entries.length} books on Goodreads ${label} shelf.`, 'info');
        return entries;
    }

    async run() {
        try {
            if (!this.hcToken || !this.rssUrl) {
                this.log("Missing credentials.", "error");
                return this.results;
            }

            // Fetch Currently Reading first, then Read.
            // If Goodreads briefly exposes a book in both feeds, Read wins because it is processed last.
            const currentlyReadingEntries = await this.fetchShelf('currently-reading', 'Currently Reading');
            const readEntries = await this.fetchShelf('read', 'Read');

            this.log("Fetching Hardcover Library...", "info");
            const library = await this.getHardcoverLibrary();
            this.log(`Library loaded. ${library.byBookId.size} books.`, "info");

            await this.processShelf(currentlyReadingEntries, 2, 'Currently Reading', library);
            await this.processShelf(readEntries, 3, 'Read', library);

            return this.results;
        } catch (e) {
            this.log(`Sync Critical Error: ${e.message}`, 'error');
            throw e;
        }
    }

    async processShelf(entries, desiredStatusId, label, library) {
        if (entries.length === 0) {
            this.log(`No books found on Goodreads ${label} shelf.`, 'debug');
            return;
        }

        const limitVal = this.limit === 0 ? entries.length : (this.limit || 20);
        const processList = entries.slice(0, limitVal).reverse();

        this.log(
            `Processing ${processList.length} Goodreads ${label} books... (Limit: ${this.limit === 0 ? 'ALL' : limitVal})`,
            'info'
        );

        for (const entry of processList) {
            if (!entry.title || !entry.author_name) {
                this.log(`[Skip] RSS entry is missing title/author.`, 'warn');
                continue;
            }

            try {
                let existingUserBook = this.findExistingUserBook(entry, library);
                let bookId = existingUserBook?.book?.id ?? null;

                if (!bookId) {
                    this.log(`[Candidate] '${entry.title}' - Verifying...`, 'info');

                    bookId = await this.searchHardcoverBookId(
                        entry.title,
                        entry.author_name,
                        entry.isbn13 || entry.isbn
                    );

                    if (!bookId) {
                        this.log(`[No Match] Could not find '${entry.title}' in Hardcover.`, 'warn');
                        continue;
                    }

                    existingUserBook = library.byBookId.get(bookId) || null;
                }

                if (existingUserBook) {
                    await this.handleExistingBook(
                        existingUserBook,
                        entry,
                        desiredStatusId,
                        label,
                        library
                    );
                } else {
                    await this.handleNewBook(
                        bookId,
                        entry,
                        desiredStatusId,
                        label,
                        library
                    );
                }
            } catch (e) {
                this.log(`❌ Error syncing '${entry.title}': ${e.message}`, 'error');
                this.results.errors.push(`${entry.title} (${e.message})`);
            }

            await new Promise(r => setTimeout(r, 2000));
        }
    }

    findExistingUserBook(entry, library) {
        const isbnCandidates = [
            this.normalizeIsbn(entry.isbn13),
            this.normalizeIsbn(entry.isbn)
        ].filter(Boolean);

        for (const isbn of isbnCandidates) {
            const hit = library.byIsbn.get(isbn);
            if (hit) return hit;
        }

        const normalizedTitle = entry.title.trim().toLowerCase();
        const exactTitleMatches = library.byTitle.get(normalizedTitle) || [];

        for (const ub of exactTitleMatches) {
            if (this.authorMatches(entry.author_name, ub)) return ub;
        }

        for (const ub of library.userBooks) {
            if (!ub.book?.title) continue;

            const titleScore = Utils.tokenSortRatio(entry.title, ub.book.title);
            if (titleScore > 90 && this.authorMatches(entry.author_name, ub)) {
                return ub;
            }
        }

        return null;
    }

    authorMatches(author, userBook) {
        if (!author) return true;

        const authors = (userBook.book?.contributions || [])
            .map(c => c.author?.name)
            .filter(Boolean);

        if (authors.length === 0) return true;

        return authors.some(existingAuthor =>
            Utils.tokenSortRatio(author, existingAuthor) > 70
        );
    }

    async handleExistingBook(userBook, entry, desiredStatusId, label, library) {
        const currentStatusId = userBook.status_id;
        const bookId = userBook.book.id;

        // Never let a stale Currently Reading RSS entry downgrade something already marked Read.
        if (desiredStatusId === 2 && currentStatusId === 3) {
            this.log(`[Skip] '${entry.title}' is already Read on Hardcover.`, 'debug');
            return;
        }

        if (currentStatusId === desiredStatusId) {
            this.log(`[Skip] '${entry.title}' is already ${label} on Hardcover.`, 'debug');
            return;
        }

        this.log(
            `[Status Change] '${entry.title}': Hardcover status ${currentStatusId} → ${desiredStatusId} (${label})`,
            'info'
        );

        if (this.isDryRun) {
            this.results.updatedBooks++;
            this.results.updated.push({
                title: entry.title,
                id: bookId,
                statusId: desiredStatusId
            });
            return;
        }

        await this.updateBookStatus(userBook.id, desiredStatusId);

        if (desiredStatusId === 3) {
            const rating = this.validRating(entry.user_rating);
            if (rating !== null) {
                await this.updateBookRating(userBook.id, rating);
            }

            await this.addReadDateFromEntry(userBook.id, entry);
        }

        userBook.status_id = desiredStatusId;

        this.results.updatedBooks++;
        this.results.updated.push({
            title: entry.title,
            id: bookId,
            statusId: desiredStatusId
        });

        this.log(`✅ Updated: ${entry.title} → ${label}`, 'success');

        // Keep lookup maps in sync with the status change.
        library.byBookId.set(bookId, userBook);
    }

    async handleNewBook(bookId, entry, desiredStatusId, label, library) {
        this.log(`[Verified New] '${entry.title}' (ID: ${bookId}) → ${label}`, 'success');

        if (this.isDryRun) {
            this.results.newBooks++;
            this.results.added.push({
                title: entry.title,
                id: bookId,
                statusId: desiredStatusId
            });
            return;
        }

        const rating = desiredStatusId === 3 ? this.validRating(entry.user_rating) : null;
        const userBookId = await this.addBookToHardcover(bookId, desiredStatusId, rating);

        if (!userBookId) {
            this.log(`❌ Failed to add: ${entry.title}`, 'error');
            this.results.errors.push(entry.title);
            return;
        }

        const newUserBook = {
            id: userBookId,
            status_id: desiredStatusId,
            rating,
            book: {
                id: bookId,
                title: entry.title,
                contributions: entry.author_name
                    ? [{ author: { name: entry.author_name } }]
                    : [],
                editions: []
            }
        };

        library.userBooks.push(newUserBook);
        library.byBookId.set(bookId, newUserBook);

        const titleKey = entry.title.trim().toLowerCase();
        if (!library.byTitle.has(titleKey)) library.byTitle.set(titleKey, []);
        library.byTitle.get(titleKey).push(newUserBook);

        const isbnCandidates = [
            this.normalizeIsbn(entry.isbn13),
            this.normalizeIsbn(entry.isbn)
        ].filter(Boolean);

        for (const isbn of isbnCandidates) {
            library.byIsbn.set(isbn, newUserBook);
        }

        this.results.newBooks++;
        this.results.added.push({
            title: entry.title,
            id: bookId,
            statusId: desiredStatusId
        });

        this.log(`✅ Added: ${entry.title} → ${label}`, 'success');

        if (desiredStatusId === 3) {
            await this.addReadDateFromEntry(userBookId, entry);
        }
    }

    parseGoodreadsDate(rawDate) {
        if (!rawDate) return null;

        const match = rawDate.match(/(\d{1,2})\s+([A-Za-z]{3})\s+(\d{4})/);

        if (match) {
            const [, day, monthStr, year] = match;
            const months = {
                Jan: '01', Feb: '02', Mar: '03', Apr: '04',
                May: '05', Jun: '06', Jul: '07', Aug: '08',
                Sep: '09', Oct: '10', Nov: '11', Dec: '12'
            };

            const month = months[monthStr];
            if (month) {
                return `${year}-${month}-${day.padStart(2, '0')}`;
            }
        }

        const d = new Date(rawDate);
        if (!Number.isNaN(d.getTime())) {
            return d.toISOString().split('T')[0];
        }

        return null;
    }

    async addReadDateFromEntry(userBookId, entry) {
        // Preserve the original behaviour: prefer Goodreads' explicit read date,
        // falling back to date-added only when Goodreads doesn't provide one.
        const rawDate = entry.user_read_at || entry.user_date_added;

        if (!rawDate) {
            this.log(`No date found for '${entry.title}' (read_at and date_added both empty)`, 'warn');
            return;
        }

        this.log(
            `Received Date: '${rawDate}' (Source: ${entry.user_read_at ? 'Read At' : 'Date Added'})`,
            'debug'
        );

        const dateStr = this.parseGoodreadsDate(rawDate);

        if (!dateStr) {
            this.log(`Could not parse date: '${rawDate}'`, 'warn');
            return;
        }

        this.log(`Adding Read Date: ${dateStr}`, 'info');
        await this.addReadDate(userBookId, dateStr);
    }

    // --- API Helpers ---

    async graphqlQuery(query, variables, retries = 3) {
        const authHeader = this.hcToken.startsWith("Bearer ")
            ? this.hcToken
            : `Bearer ${this.hcToken}`;

        try {
            const res = await fetch(this.hcEndpoint, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': authHeader
                },
                body: JSON.stringify({ query, variables })
            });

            if (res.status === 429) {
                if (retries > 0) {
                    this.log(`[API] Throttled. Waiting 3s...`, 'warn');
                    await new Promise(r => setTimeout(r, 3000));
                    return this.graphqlQuery(query, variables, retries - 1);
                }

                throw new Error("429 Throttled (Max Retries)");
            }

            if (!res.ok) {
                const text = await res.text();
                throw new Error(`API Error ${res.status}: ${res.statusText} | ${text}`);
            }

            const json = await res.json();

            if (json.errors) {
                throw new Error("GraphQL Error: " + JSON.stringify(json.errors));
            }

            return json;
        } catch (e) {
            if (retries > 0 && e.message.includes("Failed to fetch")) {
                this.log(`Network Error. Retry...`, 'warn');
                await new Promise(r => setTimeout(r, 2000));
                return this.graphqlQuery(query, variables, retries - 1);
            }

            throw e;
        }
    }

    async getHardcoverLibrary() {
        const query = `
            query GetMyBooks {
                me {
                    user_books {
                        id
                        status_id
                        rating
                        book {
                            id
                            title
                            contributions {
                                author {
                                    name
                                }
                            }
                            editions {
                                isbn_10
                                isbn_13
                            }
                        }
                    }
                }
            }
        `;

        const res = await this.graphqlQuery(query);
        const userBooks = res.data.me?.[0]?.user_books || [];

        const byBookId = new Map();
        const byIsbn = new Map();
        const byTitle = new Map();

        for (const ub of userBooks) {
            if (!ub.book) continue;

            byBookId.set(ub.book.id, ub);

            const titleKey = ub.book.title?.trim().toLowerCase();
            if (titleKey) {
                if (!byTitle.has(titleKey)) byTitle.set(titleKey, []);
                byTitle.get(titleKey).push(ub);
            }

            for (const edition of ub.book.editions || []) {
                const isbn10 = this.normalizeIsbn(edition.isbn_10);
                const isbn13 = this.normalizeIsbn(edition.isbn_13);

                if (isbn10) byIsbn.set(isbn10, ub);
                if (isbn13) byIsbn.set(isbn13, ub);
            }
        }

        return {
            userBooks,
            byBookId,
            byIsbn,
            byTitle
        };
    }

    async searchHardcoverBookId(title, author, isbn) {
        const candidates = {};

        const searchAndVerify = async (searchTitle, sourceLabel) => {
            const query = `
                query SearchBooks($title: String!) {
                    books(
                        where: {title: {_eq: $title}},
                        limit: 50,
                        order_by: {users_count: desc}
                    ) {
                        id
                        title
                        users_count
                        contributions {
                            author {
                                name
                            }
                        }
                    }
                }
            `;

            const res = await this.graphqlQuery(query, { title: searchTitle });

            (res.data.books || []).forEach(bk => {
                const authors = (bk.contributions || [])
                    .map(c => c.author?.name)
                    .filter(Boolean);

                if (authors.some(ba => Utils.tokenSortRatio(author, ba) > 70)) {
                    if (!candidates[bk.id]) {
                        candidates[bk.id] = {
                            ...bk,
                            match_source: sourceLabel
                        };
                    }
                }
            });
        };

        if (isbn) {
            const normalizedIsbn = this.normalizeIsbn(isbn);

            if (normalizedIsbn) {
                const query = `
                    query SearchByISBN($isbn: String!) {
                        editions(
                            where: {
                                _or: [
                                    {isbn_10: {_eq: $isbn}},
                                    {isbn_13: {_eq: $isbn}}
                                ]
                            }
                        ) {
                            book {
                                id
                                title
                                users_count
                            }
                        }
                    }
                `;

                const res = await this.graphqlQuery(query, { isbn: normalizedIsbn });

                (res.data.editions || []).forEach(ed => {
                    if (ed.book && !candidates[ed.book.id]) {
                        candidates[ed.book.id] = {
                            ...ed.book,
                            match_source: 'ISBN'
                        };
                    }
                });
            }
        }

        await searchAndVerify(title.trim(), "FullTitle");

        const separators = [':', '(', '-'];

        for (const sep of separators) {
            if (title.includes(sep)) {
                const short = title.split(sep)[0].trim();

                if (short.length >= 4) {
                    await searchAndVerify(short, `ShortTitle(${sep})`);
                }
            }
        }

        const finalist = Object.values(candidates)
            .sort((a, b) => (b.users_count || 0) - (a.users_count || 0));

        return finalist.length ? finalist[0].id : null;
    }

    async addBookToHardcover(bookId, statusId, rating = null) {
        const mutation = `
            mutation AddUserBook($book_id: Int!, $status_id: Int!, $rating: numeric) {
                insert_user_book(
                    object: {
                        book_id: $book_id,
                        status_id: $status_id,
                        rating: $rating
                    }
                ) {
                    id
                    user_book {
                        id
                    }
                    error
                }
            }
        `;

        const res = await this.graphqlQuery(mutation, {
            book_id: bookId,
            status_id: statusId,
            rating
        });

        const data = res.data.insert_user_book;

        if (data?.error) {
            if (data.error.includes("Uniqueness violation")) {
                this.log(`[Duplicate] Book ID ${bookId} already in library (API).`, 'warn');
            } else {
                this.log(`[API Error] Failed to add book ${bookId}: ${data.error}`, 'error');
            }

            return null;
        }

        return data?.user_book?.id || data?.id || null;
    }

    async updateBookStatus(userBookId, statusId) {
        const mutation = `
            mutation UpdateUserBookStatus($id: Int!, $status_id: Int!) {
                update_user_book(
                    id: $id,
                    object: {status_id: $status_id}
                ) {
                    id
                    error
                }
            }
        `;

        const res = await this.graphqlQuery(mutation, {
            id: userBookId,
            status_id: statusId
        });

        const data = res.data.update_user_book;

        if (data?.error) {
            throw new Error(`Failed to update status: ${data.error}`);
        }

        if (!data?.id) {
            throw new Error(`Hardcover did not return an updated user book ID`);
        }
    }

    async updateBookRating(userBookId, rating) {
        const mutation = `
            mutation UpdateUserBookRating($id: Int!, $rating: numeric!) {
                update_user_book(
                    id: $id,
                    object: {rating: $rating}
                ) {
                    id
                    error
                }
            }
        `;

        const res = await this.graphqlQuery(mutation, {
            id: userBookId,
            rating
        });

        const data = res.data.update_user_book;

        if (data?.error) {
            throw new Error(`Failed to update rating: ${data.error}`);
        }
    }

async addReadDate(userBookId, finishedAt) {
    // Check existing reading-history rows first so repeated syncs
    // cannot create duplicate "Read" entries for the same date.
    const existingQuery = `
        query ExistingReadDates($user_book_id: Int!) {
            user_book_reads(
                where: {user_book_id: {_eq: $user_book_id}}
            ) {
                id
                finished_at
            }
        }
    `;

    const existingRes = await this.graphqlQuery(existingQuery, {
        user_book_id: userBookId
    });

    const existingReads = existingRes.data.user_book_reads || [];

    const duplicate = existingReads.some(
        read => read.finished_at === finishedAt
    );

    if (duplicate) {
        this.log(
            `[Skip] Read date ${finishedAt} already exists for Hardcover user book ${userBookId}.`,
            'debug'
        );
        return;
    }

    const mutation = `
        mutation AddReadDate($user_book_id: Int!, $finished_at: date) {
            insert_user_book_read(
                user_book_id: $user_book_id,
                user_book_read: {finished_at: $finished_at}
            ) {
                id
            }
        }
    `;

    await this.graphqlQuery(mutation, {
        user_book_id: userBookId,
        finished_at: finishedAt
    });

    this.log(
        `Added new Hardcover read-history entry for ${finishedAt}.`,
        'debug'
    );
}
