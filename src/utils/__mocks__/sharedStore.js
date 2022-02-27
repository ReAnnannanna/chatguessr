'use strict';

class MockStore {
    #data;
    constructor (data = {}) {
        this.#data = data;
    }

    setData (data) {
        this.#data = data;
    }

    get (path) {
        return path.split('.').reduce((data, prop) => data?.[prop] ?? null, this.#data);
    }
    delete (path) {
		  const objPath = path.split('.');
		  const member = objPath.pop();
        const obj = objPath.reduce((data, prop) => data?.[prop] ?? null, this.#data);
		  if (obj && member) {
				delete obj[member];
		  }
    }
}

module.exports = new MockStore();
