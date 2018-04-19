var _ = require('lodash');
var pathToRegexp = require('path-to-regexp');

var swagger = {
    swagger: "2.0",
    info: {},
    paths: {},
    definitions: {}
};

function toSwagger(apidocJson, projectJson, definitions) {
    swagger.definitions = definitions || swagger.definitions;
    swagger.info = addInfo(projectJson);
    swagger.paths = extractPaths(apidocJson);
    return swagger;
}

var tagsRegex = /(<([^>]+)>)/ig;
// Removes <p> </p> tags from text
function removeTags(text) {
    return text ? text.replace(tagsRegex, "") : text;
}

function addInfo(projectJson) {
    var info = {};
    info["title"] = projectJson.title || projectJson.name;
    info["version"] = projectJson.version;
    info["description"] = projectJson.description;
    return info;
}

/**
 * Extracts paths provided in json format
 * post, patch, put request parameters are extracted in body
 * get and delete are extracted to path parameters
 * @param apidocJson
 * @returns {{}}
 */
function extractPaths(apidocJson) {
    var apiPaths = groupByUrl(apidocJson);
    var paths = {};
    for (var i = 0; i < apiPaths.length; i++) {
        var verbs = apiPaths[i].verbs;
        var url = verbs[0].url;
        var pattern = pathToRegexp(url, null);
        var matches = pattern.exec(url);

        // Surrounds URL parameters with curly brackets -> :email with {email}
        var pathKeys = [];
        for (var j = 1; j < matches.length; j++) {
            var key = matches[j].substr(1);
            url = url.replace(matches[j], "{" + key + "}");
            pathKeys.push(key);
        }

        for (var j = 0; j < verbs.length; j++) {
            var verb = verbs[j];
            var type = verb.type;

            if (type) {
                type = type.toLowerCase();
            }

            var obj = paths[url] = paths[url] || {};

            if (type == 'post' || type == 'patch' || type == 'put') {
                _.extend(obj, createPostPushPutOutput(verb, swagger.definitions, pathKeys));
            } else {
                _.extend(obj, createGetDeleteOutput(verb, swagger.definitions));
            }
        }
    }
    return paths;
}

function createPostPushPutOutput(verbs, definitions, pathKeys) {
    var pathItemObject = {};
    var verbDefinitionResults = createVerbDefinitions(verbs, definitions);

    var params = [];
    var pathParams = createPathParameters(verbs, pathKeys);
    params = _.filter(pathParams, function(param) {
        var hasKey = pathKeys.indexOf(param.name) !== -1;
        return param.in === "path" || param.in === 'query' || param.in.toLowerCase() === 'formdata' || hasKey;
    });

    var body;

    if(verbs.parameter && verbs.parameter.fields) {
        body = verbs.parameter.fields.Body || verbs.parameter.fields.body;
    }

    var required = body && body.length > 0;

    var item = {
        "in": "body",
        "name": "body",
        "description": removeTags(verbDefinitionResults.params.topLevelDescription),
        "required": required,
        "schema": {
            "$ref": "#/definitions/" + verbDefinitionResults.params.topLevelRef
        }
    };

    // Delete ref property when there is no reference.
    if (!definitions[verbDefinitionResults.params.topLevelRef]) {
        delete item.schema.$ref;
    }

    // When the toplevel is a array of primitives
    //  - remove schema
    //  - Add items object and type.
    if (verbDefinitionResults.params.topLevelRefItemsType) {
        item.schema = {
            type: "array",
            items: {
                type: verbDefinitionResults.params.topLevelRefItemsType
            }
        };
    }

    if (required) {
        params.push(item);
    }

    pathItemObject[verbs.type.toLowerCase()] = {
        tags: [verbs.group],
        "x-permission": _.map(_.get(verbs, "permission", []), "name"),
        description: removeTags(verbs.title),
        summary: removeTags(verbs.description),
        consumes: [
            "application/json"
        ],
        produces: [
            "application/json"
        ],
        parameters: params
    };

    generateResponses(pathItemObject, verbDefinitionResults, definitions, verbs.type.toLowerCase());

    return pathItemObject;
}

function createVerbDefinitions(verbs, definitions) {
    var result = {
        params: {},
        response: {}
    };
    var defaultObjectName = verbs.name;

    var fieldArrayResult = {};
    if (verbs && verbs.parameter && verbs.parameter.fields) {
        var bodyParams = verbs.parameter.fields.body || verbs.parameter.fields.Body || {};
        fieldArrayResult = createFieldArrayDefinitions(bodyParams, definitions, verbs.name, defaultObjectName, 'parameter');
        result.params.topLevelRef = fieldArrayResult.topLevelRef;
        result.params.topLevelRefType = fieldArrayResult.topLevelRefType;
        result.params.topLevelRefItemsType = fieldArrayResult.topLevelRefItemsType;
        result.params.topLevelDescription = fieldArrayResult.topLevelDescription;
    }

    if (verbs && verbs.success && verbs.success.fields) {
        for (var i in verbs.success.fields) {
            if (verbs.success.fields[i]) {
                fieldArrayResult = createFieldArrayDefinitions(verbs.success.fields[i], definitions, verbs.name, defaultObjectName);
                result.response[i] = {
                    topLevelRef: fieldArrayResult.topLevelRef,
                    topLevelRefType: fieldArrayResult.topLevelRefType,
                    topLevelRefItemsType: fieldArrayResult.topLevelRefItemsType,
                    topLevelDescription: fieldArrayResult.topLevelDescription
                };
            }
        }
    }

    if (verbs && verbs.error && verbs.error.fields) {
        for (var i in verbs.error.fields) {
            fieldArrayResult = createFieldArrayDefinitions(verbs.error.fields[i], definitions, verbs.name, defaultObjectName);
            result.response[i] = {
                topLevelRef: fieldArrayResult.topLevelRef,
                topLevelRefType: fieldArrayResult.topLevelRefType,
                topLevelRefItemsType: fieldArrayResult.topLevelRefItemsType,
                topLevelDescription: fieldArrayResult.topLevelDescription
            };
        }
    }

    return result;
}

function createFieldArrayDefinitions(fieldArray, definitions, topLevelRef, defaultObjectName) {
    var result = {
        topLevelRef: topLevelRef,
        topLevelRefType: null
    };

    if (!fieldArray) {
        return result;
    }

    for (var i = 0; i < fieldArray.length; i++) {
        var parameter = fieldArray[i];
        var type = parameter.type || "";

        if(type.toLowerCase() === 'date') {
            type = 'String';
        }

        var nestedName = createNestedName(parameter.field);
        var objectName = nestedName.objectName;
        if (!objectName) {
            objectName = defaultObjectName;
        }

        if (i === 0) {
            result.topLevelRefType = type;

            if (type && type.toLowerCase() === "object") {
                objectName = nestedName.propertyName;
                nestedName.propertyName = null;
            } else if (type && (type.toLowerCase() === "array" || type.slice(-2) === "[]")) {
                objectName = nestedName.propertyName;
                nestedName.propertyName = null;
                result.topLevelRefType = "array";
                var itemsType = ((type.substr(0, type.length -2)) || "").toLowerCase();
                if(itemsType && itemsType !== "object") {
                    result.topLevelRefItemsType = ((type.substr(0, type.length -2)) || "").toLowerCase();
                }
            } else if ((type || '').toLowerCase() === 'file') {
                objectName = nestedName.propertyName;
                nestedName.propertyName = null;
                result.topLevelRefType = "file";
            }

            result.topLevelRef = objectName;
            result.topLevelDescription = removeTags(parameter.description);
        }

        if (type) {

            definitions[objectName] = definitions[objectName] || {
                type: type.toLowerCase() === 'object' ? type.toLowerCase() : undefined,
                properties: {},
                required: []
            };

            if (nestedName.propertyName) {

                var prop = {
                    type: (type || "").toLowerCase() || undefined,
                    description: removeTags(parameter.description).trim()
                };

                if (type.toLowerCase() === "object") {
                    prop.$ref = "#/definitions/" + objectName + '.' + nestedName.propertyName;
                    delete prop.type;
                    delete prop.description;
                }

                // User items ref when type is 'Array' or when type is "Object[]";
                if (type.toLowerCase() === "array" || type.toLowerCase() === 'object[]') {
                    prop.type = "array";
                    prop.items = {
                        $ref: "#/definitions/" + objectName + "." + nestedName.propertyName
                    };
                } else if (type.slice(-2) === "[]") { // When type is defined as "Type[]" and use the type as items type.
                    prop.type = "array";
                    prop.items = {
                        type: ( (type.substr(0, type.length -2) || '').toLowerCase() ) || undefined
                    };
                }

                definitions[objectName].properties[nestedName.propertyName] = prop;
                if (!parameter.optional) {
                    var arr = definitions[objectName].required;
                    if (arr.indexOf(nestedName.propertyName) === -1) {
                        arr.push(nestedName.propertyName);
                    }
                }
            }
        }
    }

    // Remove empty definitions
    for (var objectN in definitions) {
        if (!Object.keys(definitions[objectN].properties).length) {
            delete definitions[objectN];
        }
    }

    // Remove references that don't exist
    for (var objectN in definitions) {
        for (var key in definitions[objectN].properties) {
            var property = definitions[objectN].properties[key];

            if (property.$ref && !definitions[property.$ref.replace('#/definitions/', '')]) {
                delete property.$ref;
            } else if (property.items && property.items.$ref && !definitions[property.items.$ref.replace('#/definitions/', '')]) {
                property.items = {};
            }
        }
    }

    return result;
}

function createNestedName(field) {
    var propertyName = field;
    var objectName;
    var propertyNames = field.split(".");
    if (propertyNames && propertyNames.length > 1) {
        propertyName = propertyNames[propertyNames.length - 1];
        propertyNames.pop();
        objectName = propertyNames.join(".");
    }

    return {
        propertyName: propertyName,
        objectName: objectName
    };
}

function generateResponses(pathItemObject, verbDefinitionResults, definitions, type) {
    var responses = {};
    
    for (var i in verbDefinitionResults.response) {
        var key = i === "Success 200" ? "200" : i === "Error 4xx" ? "400" : i
        if (verbDefinitionResults.response[i].topLevelRef && verbDefinitionResults.response[i].topLevelRefType && definitions[verbDefinitionResults.response[i].topLevelRef]) {
            switch (verbDefinitionResults.response[i].topLevelRefType.toLowerCase()) {
                case 'object':
                    responses[key] = {
                        "description": verbDefinitionResults.response[i].topLevelDescription,
                        "schema": {
                            "$ref": "#/definitions/" + verbDefinitionResults.response[i].topLevelRef
                        }
                    };
                    break;
                case 'array':
                    responses[key] = {
                        "description": verbDefinitionResults.response[i].topLevelDescription,
                        "schema": {
                            "type": "array",
                            "items": {
                                "$ref": "#/definitions/" + verbDefinitionResults.response[i].topLevelRef
                            }
                        }
                    };
                    break;
                default:
                    responses[key] = {
                        "description": verbDefinitionResults.response[i].topLevelDescription,
                        "schema": {
                            "type": verbDefinitionResults.response[i].topLevelRefType.toLowerCase(),
                            "$ref": "#/definitions/" + verbDefinitionResults.response[i].topLevelRef
                        }
                    };
                    break;
            }
        } else if (verbDefinitionResults.response[i].topLevelRef) {
            responses[key] = {
                "description": verbDefinitionResults.response[i].topLevelDescription
            };

            if(verbDefinitionResults.response[i].topLevelRefType === "array" && verbDefinitionResults.response[i].topLevelRefItemsType) {
                responses[key].schema =  {
                    "type": "array",
                    "items": {
                        "type": verbDefinitionResults.response[i].topLevelRefItemsType
                    }
                };
            }
        }
    }

    pathItemObject[type].responses = responses;
}

/**
 * Generate get, delete method output
 * @param verbs
 * @returns {{}}
 */
function createGetDeleteOutput(verbs, definitions) {
    var pathItemObject = {};
    verbs.type = verbs.type && verbs.type.toLowerCase() === "del" ? "delete" : (verbs.type ? verbs.type.toLowerCase() : '');
    var verbDefinitionResults = createVerbDefinitions(verbs, definitions);
    pathItemObject[verbs.type] = {
        tags: [verbs.group],
        "x-permission": _.map(_.get(verbs, "permission", []), "name"),
        description: removeTags(verbs.title),
        summary: removeTags(verbs.description),
        consumes: [
            "application/json"
        ],
        produces: [
            "application/json"
        ],
        parameters: createPathParameters(verbs)
    };

    generateResponses(pathItemObject, verbDefinitionResults, definitions, verbs.type);

    return pathItemObject;
}

/**
 * Iterate through all method parameters and create array of parameter objects which are stored as path parameters
 * @param verbs
 * @returns {Array}
 */
function createPathParameters(verbs, pathKeys) {
    pathKeys = pathKeys || [];

    var pathItemObject = [];
    if (verbs.parameter) {

        for (var j in verbs.parameter.fields) {
            for (var i = 0; i < verbs.parameter.fields[j].length; i++) {
                var param = verbs.parameter.fields[j][i];

                var item = {
                    name: param.field,
                    in : "path",
                    required: !param.optional,
                    type: param.type ? param.type.toLowerCase() : undefined,
                    description: removeTags(param.description)
                };

                if (param.type && param.type.toLowerCase() === 'file') {
                    item.in = "formData";
                } else if (j && j.toLowerCase() === 'body') {
                    item.in = 'body';
                    item.schema = {};
                    delete item.type;
                } else if(j.toLowerCase() === 'header' || j.toLowerCase() === 'headers') {
                    item.in = 'header';
                } else if (j.toLowerCase() === 'query') {
                    item.in = "query";
                }

                pathItemObject.push(item);
            }
        }
    }
    return pathItemObject;
}

function groupByUrl(apidocJson) {
    return _.chain(apidocJson)
        .groupBy("url")
        .pairs()
        .map(function(element) {
            return _.object(_.zip(["url", "verbs"], element));
        })
        .value();
}

module.exports = {
    toSwagger: toSwagger
};

