/**
 * Parses an hl7 v2 message and converts to json representation
 * @param  {String} hl7
 * @return {JSON}
 */
module.exports = function (hl7, skipValidation) {
  var schema, messageEventKey, messageType, eventType;
  var segmentArray, delimiters = {}, MSHArray;
  var ret = {}, messageDef, segmentIndex = {};

  var self = this;

  if (hl7.indexOf('\r\n') !== -1) {
    segmentArray = hl7.split('\r\n');
  } else {
    segmentArray = hl7.split('\r');
    if (segmentArray.length < 2) {
      segmentArray = hl7.split('\n');
    }
  }

  //if delimiters other than the defaults are being used, find them
  //assume MSH is first segment - it's not necessarilly the first segment, but should be unless BHS segments are in play
  //if a customer is sending us BHS segments, we should write a batch message V2, then call this function on each message
  if (segmentArray[0] && segmentArray[0].substring(0,3) === 'MSH') {

    delimiters.field = segmentArray[0].substring(3,4); // |
    delimiters.component = segmentArray[0].substring(4,5); // ^
    delimiters.repetition = segmentArray[0].substring(5,6); // ~
    delimiters.escape = segmentArray[0].substring(6,7); // \
    delimiters.subComponent = segmentArray[0].substring(7,8); // &

    MSHArray = segmentArray[0].split(delimiters.field);
    MSHArray.splice(1, 0, delimiters.field); // Add field delimiter back in to make length correct

    messageType = MSHArray[9].split(delimiters.component)[0];

    if (messageType === 'ACK') {
      eventType = 'ACK';
    } else {
      eventType = MSHArray[9].split(delimiters.component)[1];
    }

  } else {
    throw new Error('Could not read MSH segment of HL7 v2 message.');
  }

  schema = self._schema;
  messageEventKey = schema.structure[messageType][eventType];

  messageDef = schema.messages[messageEventKey];

  if (hl7.indexOf('\r\n') !== -1) {
    segmentArray = hl7.split('\r\n');
  } else {
    segmentArray = hl7.split('\r');
    if (segmentArray.length < 2) {
      segmentArray = hl7.split('\n');
    }
  }

  /**
   * Builds an index with the segment names as the keys and the groups that segment is in as the values
   * @param  {Object} segmentIndex The segmentIndex so far
   * @param  {Object} messageDef   The message definition we're building
   * @param  {String} groupName    The name of the current group we're processing
   * @return {Object}              Implicitly returns the index in teh segmentIndex variable
   */
  var buildGroupIndex = function (segmentIndex, messageDef, groupName) {
    for (var i = 0; i < messageDef[groupName].elements.length; i++) {
      if (messageDef[groupName].elements[i].segment) {
        if (!segmentIndex[messageDef[groupName].elements[i].segment]) {
          segmentIndex[messageDef[groupName].elements[i].segment] = {};
        }
        segmentIndex[messageDef[groupName].elements[i].segment][groupName] = true;
      } else {
        buildGroupIndex(segmentIndex, messageDef, messageDef[groupName].elements[i].group);
        for (var segment in segmentIndex) {
          if (segmentIndex[segment][messageDef[groupName].elements[i].group]) {
            segmentIndex[segment][groupName] = true;
          }
        }
      }
    }
  };

  buildGroupIndex(segmentIndex, messageDef, messageEventKey);

  // Remove any empty segments or segments not defined for this message type
  for (var i = 0; i < segmentArray.length; i++) {

    if (!segmentArray[i]) {
      segmentArray.splice(i, 1);
      i--;
      continue;
    }

    // If the segment is not defined in this message type, remove it
    if (!segmentIndex[segmentArray[i].substring(0, 3)] || !segmentIndex[segmentArray[i].substring(0,3)][messageEventKey]) {
      segmentArray.splice(i, 1);
      i--;
    }
  }

  /**
   * Unpacks a group of segments - defined as a separate function becuase we have to use recursion
   * @param  {Array} segmentArray Array of segments
   * @param  {Object} messageDef   The definition of this message type
   * @param  {String} groupName    The name of the group we are unpacking
   * @return {Object}              The unpacked group
   */
  var parseGroup = function (segmentArray, messageDef, groupName, skipValidation) {
    var ret = {}, segment, segmentName, element, moveOn = true, completedKeys = {};

    for (var i = 0; i < messageDef[groupName].elements.length; i++) {

      if (segmentArray.length === 0 && moveOn) {

        for (var j = i; j < messageDef[groupName].elements.length; j++ ) {
          element = messageDef[groupName].elements[j];
          // If we're missing some required group or segment that we haven't gotten to yet
          if (!skipValidation && parseInt(element.minOccurs) > 0) {
            if (element.segment) {
              throw new Error('Message is missing required segment ' + element.segment + '.');
            } else {
              throw new Error('Message is missing required group ' + element.group + '.');
            }
          }
        }

        return ret;
      }

      element = messageDef[groupName].elements[i];

      if (moveOn) {
        segment = segmentArray.shift();
        segmentName = segment.substring(0, 3);
      }

      // If we've already seen this key, then we must be starting a group over
      if (completedKeys[segmentName]) {
        segmentArray.unshift(segment);
        return ret;
      }

      // If this segment is not part of the group, add it back on and return
      if (!segmentIndex[segmentName] || !segmentIndex[segmentName][groupName]) {
        segmentArray.unshift(segment);
        return ret;
      }

      if (element.segment === segmentName) { // We have a match

        completedKeys[segmentName] = true;

        if (parseInt(element.maxOccurs) !== 1) {

          if (!ret[segmentName]) {
            ret[segmentName] = [];
          }

          segmentArray.unshift(segment);
          while (segmentArray[0] && segmentArray[0].substring(0, 3) === element.segment) {
            segment = segmentArray.shift();
            ret[segmentName].push(self.parseSegment(segment, segmentName, delimiters));
          }

        } else {
          ret[segmentName] = self.parseSegment(segment, segmentName, delimiters);
        }

        moveOn = true;
      } else if (!skipValidation && element.segment && parseInt(element.minOccurs) > 0) { // We've missed a required segment
        throw new Error('Message is missing required segment ' + element.segment + '.');
      } else if (element.segment && parseInt(element.minOccurs) === 0) { // optional segment that we can skip
        moveOn = false;
      } else if (element.group) { // We need to check the group for the segment

        if (segmentIndex[segmentName] && segmentIndex[segmentName][element.group]) {
          segmentArray.unshift(segment); // stick segment back on the array and recur

          if (parseInt(element.maxOccurs) !== 1) {

            if (!ret[element.group]) {
              ret[element.group] = [];
            }

            while (segmentArray.length > 0 && segmentIndex[segmentArray[0].substring(0, 3)] && segmentIndex[segmentArray[0].substring(0, 3)][element.group]) {
              ret[element.group].push(parseGroup(segmentArray, messageDef, element.group));
            }

          } else {
            ret[element.group] = parseGroup(segmentArray, messageDef, element.group);
          }
          moveOn = true;
        } else if (!skipValidation && parseInt(element.minOccurs) > 0) {
          throw new Error('Message is missing required group ' + element.group + '.');
        } else {
          moveOn = false;
        }
      }
    }


    return ret;
  };

  ret = parseGroup(segmentArray, messageDef, messageEventKey, skipValidation);

  return ret;
};
