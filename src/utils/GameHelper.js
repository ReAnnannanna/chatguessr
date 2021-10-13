const path = require("path");
require("dotenv").config({ path: path.join(__dirname, "../../.env") });

const axios = require("axios");

const CG = require("codegrid-js").CodeGrid();
const countryCodes = require("./countryCodes");
const countryCodesNames = require("./countryCodesNames");

/**
 * Checks if '/game/' is in the URL
 * @param {string} url Game URL
 * @return {boolean}
 */
function isGameURL(url) {
  return url.includes("/game/");
}

/**
 * Gets the Game ID from a game URL
 * Checks if ID is 16 characters in length
 * @param {string} url Game URL
 * @return {string|boolean} id or false
 */
function getGameId(url) {
  const id = url.substring(url.lastIndexOf("/") + 1);
  if (id.length == 16) {
    return id;
  } else {
    return false;
  }
}

/**
 * Fetch a game seed
 * @param {string} url
 * @return {Promise} Seed Promise
 */
async function fetchSeed(url) {
  return axios
    .get(
      `https://www.geoguessr.com/api/v3/games/${url.substring(
        url.lastIndexOf("/") + 1
      )}`
    )
    .then((res) => res.data)
    .catch((error) => console.log(error));
}

/**
 * Returns a country code
 * @param {Object} location {lat, lng}
 * @return {Promise} Country code Promise
 */
async function getCountryCode(location) {
  return axios
    .get(
      `https://api.bigdatacloud.net/data/reverse-geocode?latitude=${location.lat}&longitude=${location.lng}&key=${process.env.BDC_KEY}`
    )
    .then((res) => countryCodes[res.data.countryCode])
    .catch((error) => {
      // if BDC returns an error use CodeGrid
      return new Promise((resolve, reject) => {
        CG.getCode(location.lat, location.lng, (error, code) => {
          resolve(code);
          reject(new Error(error));
        });
      }).then((code) => countryCodes[code.toUpperCase()]);
    });
}

/**
 * Returns a country code
 * It uses CodeGrid first and then BDC if needed
 * @param {Object} location {lat, lng}
 * @return {Promise} Country code Promise
 */
const getCountryCodeLocally = async (location) => {
  return new Promise((resolve, reject) => {
    let coordinates = this.getSurroundings(location);
    let promises = [];
    coordinates.forEach((coord) => {
      promises.push(this.getCountryCG(coord));
    });
    Promise.all(promises).then((values) => {
      let unique = new Set(values);
      if (unique.size === 1) {
        console.log(unique.values().next().value);
      } else {
        this.getCountryBDC(location).then((data) => resolve(data));
      }
    });
  });
};

/**
 * Returns a country code (Only using BDC)
 * Do not use externally - Used by getCountryCodeLocally
 * Ultimately we will call our own API here and remove/
 * replace getCountryCode
 * @param {Object} location {lat, lng}
 * @return {Promise} Country code Promise
 */
async function getCountryBDC(location) {
  return axios
    .get(
      `https://api.bigdatacloud.net/data/reverse-geocode?latitude=${location.lat}&longitude=${location.lng}&key=${process.env.BDC_KEY}`
    )
    .then((res) => countryCodes[res.data.countryCode])
    .catch((error) => error);
}

/**
 * Returns a country code (Only using CodeGrid)
 * Do not use externally - Used by getCountryCodeLocally
 * @param {Object} location {lat, lng}
 * @return {Promise} Country code Promise
 */
function getCountryCG(location) {
  return new Promise((resolve, reject) => {
    CG.getCode(location.lat, location.lng, (error, code) => {
      if (error) {
        reject(new Error(error));
      } else {
        resolve(countryCodes[code.toUpperCase()]);
      }
    });
  });
}

/**
 * Returns an array of 9 coodinates as objects.
 * Each coordinate is 100 meters aways from the given
 * coordinate y angles from 0 to 315
 * The first coordinate is the original passed
 * @param {Object} location {lat, lng}
 * @return {Array} Coordinates [{lat, lng}, {lat, lng}] x 8
 */
function getSurroundings(location) {
  const meters = 100;
  const R_EARTH = 6378.137;
  const M = 1 / (((2 * Math.PI) / 360) * R_EARTH) / 1000;

  function moveFrom(coords, angle, distance) {
    let radianAngle = (angle * Math.PI) / 180;
    let x = 0 + distance * Math.cos(radianAngle);
    let y = 0 + distance * Math.sin(radianAngle);
    let newLat = coords.lat + y * M;
    let newLng = coords.lng + (x * M) / Math.cos(coords.lat * (Math.PI / 180));
    return { lat: newLat, lng: newLng };
  }
  let coordinates = [location];
  for (let angle = 0; angle < 360; angle += 45) {
    coordinates.push(
      moveFrom({ lat: location.lat, lng: location.lng }, angle, meters)
    );
  }
  return coordinates;
}

/**
 * Check if the param is coordinates
 * @param {string} coordinates
 * @return {boolean}
 */
function isCoordinates(coordinates) {
  const regex =
    /^[-+]?([1-8]?\d(\.\d+)?|90(\.0+)?),\s*[-+]?(180(\.0+)?|((1[0-7]\d)|([1-9]?\d))(\.\d+)?)$/g;
  return regex.test(coordinates);
}

/**
 * Returns map scale
 * @param {Object} bounds map bounds
 * @return {number} map scale
 */
function calculateScale(bounds) {
  return (
    haversineDistance(
      { lat: bounds.min.lat, lng: bounds.min.lng },
      { lat: bounds.max.lat, lng: bounds.max.lng }
    ) / 7.458421
  );
}

/**
 * Returns distance in km between two coordinates
 * @param {Object} mk1 {lat, lng}
 * @param {Object} mk2 {lat, lng}
 * @return {number} km
 */
function haversineDistance(mk1, mk2) {
  const R = 6371.071;
  const rlat1 = mk1.lat * (Math.PI / 180);
  const rlat2 = mk2.lat * (Math.PI / 180);
  const difflat = rlat2 - rlat1;
  const difflon = (mk2.lng - mk1.lng) * (Math.PI / 180);
  const km =
    2 *
    R *
    Math.asin(
      Math.sqrt(
        Math.sin(difflat / 2) * Math.sin(difflat / 2) +
          Math.cos(rlat1) *
            Math.cos(rlat2) *
            Math.sin(difflon / 2) *
            Math.sin(difflon / 2)
      )
    );
  return km;
}

/**
 * Returns score based on distance and scale
 * @param {number} distance
 * @param {number} scale
 * @return {number} score
 */
function calculateScore(distance, scale) {
  return Math.round(5000 * Math.pow(0.99866017, (distance * 1000) / scale));
}

/**
 * Returns guesses sorted by distance ASC
 * @param {array} guesses
 * @return {array} guesses
 */
function sortByDistance(guesses) {
  return guesses.sort((a, b) => a.distance - b.distance);
}

/**
 * Returns guesses sorted by score DESC
 * @param {array} guesses
 * @return {array} guesses
 */
function sortByScore(guesses) {
  return guesses.sort((a, b) => b.score - a.score);
}

/** Converts a country code into an emoji flag
 * @param {String} value
 */
function toEmojiFlag(value) {
  if (value.length == 2) {
    return value
      .toUpperCase()
      .replace(/./g, (char) =>
        String.fromCodePoint(char.charCodeAt(0) + 127397)
      );
  } else {
    const flag = value
      .toUpperCase()
      .substring(0, 2)
      .replace(/./g, (char) =>
        String.fromCodePoint(char.charCodeAt(0) + 127397)
      );
    const region = value
      .toUpperCase()
      .substring(2)
      .replace(
        /./g,
        (char) => String.fromCodePoint(char.charCodeAt(0) + 127397) + " "
      );
    return `${flag} ${region}`.trim();
  }
}

/** Replace special chars
 * @param {String} val
 */
function normalize(val) {
  return val.normalize("NFD").replace(/[\u0300-\u036f]/g, "");
}

/** Matches words above 3 letters
 * @param {String} input
 * @param {String} key
 */
function isMatch(input, key) {
  return input.length >= 3 && key.includes(input) && input.length <= key.length;
}

/** Find country by code or name
 * @param {String} input
 * @return {Object} countryCodesNames
 */
function findCountry(input) {
  const normalized = normalize(input);
  return countryCodesNames.find(
    (country) =>
      country.code === normalized ||
      isMatch(normalized, country.names.toLowerCase())
  );
}

/** Return a random country code
 * @return {String}
 */
function getRandomFlag() {
  return countryCodesNames[Math.floor(Math.random() * countryCodesNames.length)]
    .code;
}

/** Make game summary link
 * @param  {string} streamer
 * @param  {string} mapName
 * @param {Object} mode
 * @param  {Object[]} locations
 * @param  {Object[]} scores
 * @return {Promise} link
 */
function makeLink(streamer, mapName, mode, locations, totalScores) {
  const players = totalScores.map((guess) => {
    return {
      username: guess.username,
      flag: guess.flag,
      score: guess.score,
      rounds: guess.rounds,
    };
  });

  return axios
    .post(`${process.env.API_URL}/game`, {
      streamer: streamer,
      map: mapName,
		mode: mode,
      locations: locations,
      players: players,
    })
    .then((res) => {
      return `${process.env.BASE_URL}/game/${res.data.code}`;
    })
    .catch((err) => {
      console.log(err);
    });
}

exports.isGameURL = isGameURL;
exports.getGameId = getGameId;
exports.fetchSeed = fetchSeed;
exports.getCountryCode = getCountryCode;
exports.getCountryBDC = getCountryBDC;
exports.getCountryCG = getCountryCG;
exports.getCountryCodeLocally = getCountryCodeLocally;
exports.getSurroundings = getSurroundings;
exports.isCoordinates = isCoordinates;
exports.calculateScale = calculateScale;
exports.haversineDistance = haversineDistance;
exports.calculateScore = calculateScore;
exports.sortByDistance = sortByDistance;
exports.sortByScore = sortByScore;
exports.toEmojiFlag = toEmojiFlag;
exports.findCountry = findCountry;
exports.normalize = normalize;
exports.makeLink = makeLink;
exports.isMatch = isMatch;
exports.getRandomFlag = getRandomFlag;
