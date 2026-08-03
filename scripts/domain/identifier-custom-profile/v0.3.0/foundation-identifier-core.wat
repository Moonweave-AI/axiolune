(module
  (memory (export "memory") 1 1)

  (func $is_digit (param $c i32) (result i32)
    local.get $c
    i32.const 48
    i32.ge_u
    local.get $c
    i32.const 57
    i32.le_u
    i32.and)

  (func $is_upper (param $c i32) (result i32)
    local.get $c
    i32.const 65
    i32.ge_u
    local.get $c
    i32.const 90
    i32.le_u
    i32.and)

  (func $is_alnum (param $c i32) (result i32)
    local.get $c
    call $is_digit
    local.get $c
    call $is_upper
    i32.or)

  (func $char_number (param $c i32) (result i32)
    local.get $c
    call $is_digit
    if (result i32)
      local.get $c
      i32.const 48
      i32.sub
    else
      local.get $c
      i32.const 55
      i32.sub
    end)

  (func (export "validate_isin") (param $ptr i32) (param $len i32) (result i32)
    (local $i i32)
    (local $c i32)
    (local $expanded_len i32)
    (local $number i32)
    (local $sum i32)
    (local $double i32)
    (local $digit i32)

    local.get $len
    i32.const 12
    i32.ne
    if
      i32.const 1
      return
    end

    i32.const 0
    local.set $i
    block $lexical_done
      loop $lexical_loop
        local.get $ptr
        local.get $i
        i32.add
        i32.load8_u
        local.set $c
        local.get $i
        i32.const 2
        i32.lt_u
        if (result i32)
          local.get $c
          call $is_upper
        else
          local.get $i
          i32.const 11
          i32.eq
          if (result i32)
            local.get $c
            call $is_digit
          else
            local.get $c
            call $is_alnum
          end
        end
        i32.eqz
        if
          i32.const 1
          return
        end
        local.get $i
        i32.const 1
        i32.add
        local.tee $i
        local.get $len
        i32.lt_u
        br_if $lexical_loop
      end
    end

    i32.const 0
    local.set $i
    i32.const 0
    local.set $expanded_len
    block $expand_done
      loop $expand_loop
        local.get $ptr
        local.get $i
        i32.add
        i32.load8_u
        local.tee $c
        call $char_number
        local.set $number
        local.get $c
        call $is_digit
        if
          i32.const 1024
          local.get $expanded_len
          i32.add
          local.get $number
          i32.store8
          local.get $expanded_len
          i32.const 1
          i32.add
          local.set $expanded_len
        else
          i32.const 1024
          local.get $expanded_len
          i32.add
          local.get $number
          i32.const 10
          i32.div_u
          i32.store8
          i32.const 1024
          local.get $expanded_len
          i32.const 1
          i32.add
          i32.add
          local.get $number
          i32.const 10
          i32.rem_u
          i32.store8
          local.get $expanded_len
          i32.const 2
          i32.add
          local.set $expanded_len
        end
        local.get $i
        i32.const 1
        i32.add
        local.tee $i
        local.get $len
        i32.lt_u
        br_if $expand_loop
      end
    end

    local.get $expanded_len
    i32.const 1
    i32.sub
    local.set $i
    i32.const 0
    local.set $sum
    i32.const 0
    local.set $double
    block $luhn_done
      loop $luhn_loop
        i32.const 1024
        local.get $i
        i32.add
        i32.load8_u
        local.set $digit
        local.get $double
        if
          local.get $digit
          i32.const 2
          i32.mul
          local.set $digit
          local.get $digit
          i32.const 9
          i32.gt_u
          if
            local.get $digit
            i32.const 9
            i32.sub
            local.set $digit
          end
        end
        local.get $sum
        local.get $digit
        i32.add
        local.set $sum
        local.get $double
        i32.eqz
        local.set $double
        local.get $i
        i32.eqz
        br_if $luhn_done
        local.get $i
        i32.const 1
        i32.sub
        local.set $i
        br $luhn_loop
      end
    end
    local.get $sum
    i32.const 10
    i32.rem_u
    i32.eqz
    if (result i32)
      i32.const 0
    else
      i32.const 2
    end)

  (func (export "validate_lei") (param $ptr i32) (param $len i32) (result i32)
    (local $i i32)
    (local $c i32)
    (local $number i32)
    (local $remainder i32)

    local.get $len
    i32.const 20
    i32.ne
    if
      i32.const 1
      return
    end
    i32.const 0
    local.set $i
    i32.const 0
    local.set $remainder
    block $lei_done
      loop $lei_loop
        local.get $ptr
        local.get $i
        i32.add
        i32.load8_u
        local.set $c
        local.get $i
        i32.const 18
        i32.lt_u
        if (result i32)
          local.get $c
          call $is_alnum
        else
          local.get $c
          call $is_digit
        end
        i32.eqz
        if
          i32.const 1
          return
        end
        local.get $c
        call $char_number
        local.set $number
        local.get $remainder
        local.get $c
        call $is_digit
        if (result i32)
          i32.const 10
        else
          i32.const 100
        end
        i32.mul
        local.get $number
        i32.add
        i32.const 97
        i32.rem_u
        local.set $remainder
        local.get $i
        i32.const 1
        i32.add
        local.tee $i
        local.get $len
        i32.lt_u
        br_if $lei_loop
      end
    end
    local.get $remainder
    i32.const 1
    i32.eq
    if (result i32)
      i32.const 0
    else
      i32.const 2
    end)

  (func (export "validate_mic") (param $ptr i32) (param $len i32) (result i32)
    (local $i i32)
    local.get $len
    i32.const 4
    i32.ne
    if
      i32.const 1
      return
    end
    i32.const 0
    local.set $i
    block $mic_done
      loop $mic_loop
        local.get $ptr
        local.get $i
        i32.add
        i32.load8_u
        call $is_alnum
        i32.eqz
        if
          i32.const 1
          return
        end
        local.get $i
        i32.const 1
        i32.add
        local.tee $i
        local.get $len
        i32.lt_u
        br_if $mic_loop
      end
    end
    i32.const 0)

  (func (export "validate_local") (param $ptr i32) (param $len i32) (param $scheme i32) (result i32)
    (local $i i32)
    (local $c i32)
    local.get $scheme
    i32.const 1
    i32.ne
    local.get $scheme
    i32.const 2
    i32.ne
    i32.and
    if
      i32.const 5
      return
    end
    local.get $len
    i32.eqz
    if
      i32.const 3
      return
    end
    local.get $len
    i32.const 64
    i32.gt_u
    if
      i32.const 4
      return
    end
    local.get $ptr
    i32.load8_u
    call $is_alnum
    i32.eqz
    if
      i32.const 4
      return
    end
    i32.const 1
    local.set $i
    block $local_done
      loop $local_loop
        local.get $i
        local.get $len
        i32.ge_u
        br_if $local_done
        local.get $ptr
        local.get $i
        i32.add
        i32.load8_u
        local.tee $c
        call $is_alnum
        local.get $c
        i32.const 46
        i32.eq
        i32.or
        local.get $c
        i32.const 95
        i32.eq
        i32.or
        local.get $c
        i32.const 45
        i32.eq
        i32.or
        local.get $scheme
        i32.const 2
        i32.eq
        local.get $c
        i32.const 58
        i32.eq
        i32.and
        i32.or
        i32.eqz
        if
          i32.const 4
          return
        end
        local.get $i
        i32.const 1
        i32.add
        local.set $i
        br $local_loop
      end
    end
    i32.const 0)
)
