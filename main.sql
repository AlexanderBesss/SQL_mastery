select title, rental_duration from film where  rental_duration != 5;

select  * from customer  where lower(first_name) = 'mary';
select  * from rental where rental_date >= '2006-01-01';
select  * from rental where rental_date = '2006-02-14 15:16:03';

select title, length, rental_duration from film where length > 100 and rental_duration = 5;
select title, length, rental_duration from film where ( length > 100 or rental_duration = 5) or left (title ,1) = 'A';
select title, length, rental_duration from film where not rental_duration = 5;

select * from customer where email  is not null ;
select  title, rating from film where rating  != 'PG' or rating is null;

select  customer_id from customer where customer_id not  between  1 and 5;
select  customer_id from customer where customer_id not in(1,5,8);
select  first_name from customer where left(first_name, 1) in ('A', 'F', 'J');

select  first_name from customer where first_name  like 'M%';
select  first_name from customer where first_name  like '__M%';
select  first_name from customer where first_name ilike '__m%';

select  first_name from customer where first_name similar to  'M%L{2}%';

select title, length from film order by length desc, title asc;
select title, length from film order by right(title, 1), length desc;

/* execution order in SQL:
1. from
2. where
3. group by: aggrigate rows
4. having: filter the agregates
5. select
6. order by
7. limit
*/

-- Pagination
select first_name, last_name from customer order by first_name limit 5;
select first_name, last_name from customer order by first_name limit 5 offset 10;
-- Non standart pagination
select first_name, last_name from customer order by first_name offset 10 fetch next 5 rows only;

--Remove duplicate rows (Unique combination of columns)
select distinct customer_id from payment;
select distinct date_part('month', payment_date) as month, date_part('year', payment_date) as year from payment order by year, month;

--if statment
select title, length,
	case
		when length <= 60 then 'short'
		when length > 60 and length <=120 then 'long'
		when length > 120 then 'very long'
		else 'unknown'
	end as lenght_description
from film;

-- Aaggregate Funtions
select count(*) from film;
select count(distinct rating) from film;
select sum(length) from film;
select min(amount), max(amount), avg(amount) from payment;

-- GROUP BY and HAVING(filter the result)
select rating, count(*) from film group by rating;

select customer_id, staff_id, count(*) from payment
group by customer_id, staff_id 
having count(*) > 20
order by customer_id , staff_id;
-- Group by fist latter of user name
select left(first_name, 1) as first_latter, count(*) from customer
group by left(first_name, 1)
order by first_latter;

-- GROUP BY with CASE (expression should be the same in the SELECT and the GROUP BY section)
select
    case 
    	when length < 60 then 'short'
    	when length between 60 and 120 then 'medium'
    	when length > 120 then 'long'
    	else 'short'
    end,
    count(*)
from film
group by
    case 
    	when length < 60 then 'short'
    	when length between 60 and 120 then 'medium'
    	when length > 120 then 'long'
    	else 'short'
    end;
-- Short version (1 - first position in the SELECT section)
select
    case 
    	when length < 60 then 'short'
    	when length between 60 and 120 then 'medium'
    	when length > 120 then 'long'
    	else 'short'
    end,
    count(*)
from film
group by 1;
-- CASE inside aggregation fanction
select sum(case when rating in ('R', 'NC-17') then 1 else 0 end) as adult_films, 
       count(*), 
       100.0 * sum(case when rating in ('R', 'NC-17') then 1 else 0 end) as adult_films, count(*) / count(*) as persentage
from film;
-- Postgress DB simplified version
select 
	count(*) filter(where rating in ('R', 'NC-17')) as adult_films,
	count(*) filter(where rating = 'G' and length > 120) as mixed 
from film;
-- The same result using WHERE for single element
select count(*) from film where rating in ('R', 'NC-17');

-- Types in SQL
-- Strings
select concat(first_name, ' has email ', email) from customer where email is null;
select first_name || ' has email ' || coalesce(email, 'unknown')from customer where email is null; 
select first_name || ' was created on ' || create_date from customer;
select length(trim('   1234    '));
select * from address where length(trim(address2)) > 0 and address2 is not null;
-- Numbers
select pg_typeof( 3/2 ); -- result: 1 integer
select pg_typeof( 3.0/2 ); -- result: 1.5 numeric
-- 3 different ways to case string into int4
select int '33', '33'::int, cast('33' as int);
-- Cast bigint into int as funcrtion paramether
select rating, repeat('*', (count(*) / 10)::int) as "count/10" from film where rating is not null group by rating;

-- numeric(precision, scale);
-- numeric(5,2) -- 999,99 total length is 5, 2 after the comma 
-- real   -- 6 digit after comma
-- double -- 15 digit after comma
select 0.4235::numeric(5,4) * 10000000,  0.4235::real * 10000000; -- 'real' introduce some erros, 'number' is recommended

